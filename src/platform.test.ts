import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// vitest scopes module mocks to the declaring file, so each test file installs
// its own. test-helpers.ts then sees the mocked copies.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual('node:fs/promises');
  return {
    ...actual,
    readFile: vi.fn(),
    stat: vi.fn(),
    writeFile: vi.fn(),
    chmod: vi.fn(),
    unlink: vi.fn(),
  };
});

import {
  loadServerAs,
  createMockSpawn,
} from './test-helpers.js';
import type { TestClient } from './test-helpers.js';


// =============================================================================
// Platform-specific module initialisation
//
// resolveExecutable() runs once at import time and only does real work on
// Windows, where spawn() is called with shell:false and therefore cannot rely
// on PATH lookup. Exercised here by re-importing the module with the platform
// and PATH/PATHEXT faked, so the Windows resolution logic is covered from any
// host OS.
// =============================================================================

describe('resolveExecutable (Windows binary resolution)', () => {
  let binDir: string;

  beforeAll(() => {
    binDir = mkdtempSync(join(tmpdir(), 'mcp-ssh-bin-'));
    writeFileSync(join(binDir, 'ssh.EXE'), '');
    writeFileSync(join(binDir, 'scp.EXE'), '');
    // A directory named like the executable must not be mistaken for one.
    mkdirSync(join(binDir, 'ssh.CMD'));
  });

  afterAll(() => {
    rmSync(binDir, { recursive: true, force: true });
  });

  it('should resolve ssh/scp to absolute paths found on PATH', async () => {
    const win = await loadServerAs('win32', {
      // Trailing separator produces an empty entry, which must be skipped.
      PATH: `${binDir};`,
      PATHEXT: '.EXE;.CMD',
    });

    expect(win.SSH_BIN).toBe(join(binDir, 'ssh.EXE'));
    expect(win.SCP_BIN).toBe(join(binDir, 'scp.EXE'));
  });

  it('should skip directory entries that match the name but are not files', async () => {
    const win = await loadServerAs('win32', {
      PATH: binDir,
      PATHEXT: '.CMD;.EXE',   // .CMD first: ssh.CMD is a directory, not a match
    });

    expect(win.SSH_BIN).toBe(join(binDir, 'ssh.EXE'));
  });

  it('should fall back to a bare .exe name when PATH holds no match', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'mcp-ssh-empty-'));
    try {
      const win = await loadServerAs('win32', { PATH: emptyDir, PATHEXT: '.EXE' });

      expect(win.SSH_BIN).toBe('ssh.exe');
      expect(win.SCP_BIN).toBe('scp.exe');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('should fall back when PATH is unset entirely', async () => {
    const win = await loadServerAs('win32', { PATH: undefined, PATHEXT: '.EXE' });
    expect(win.SSH_BIN).toBe('ssh.exe');
  });

  it('should use the default PATHEXT list when the variable is unset', async () => {
    const win = await loadServerAs('win32', { PATH: binDir, PATHEXT: undefined });
    // .EXE is part of the built-in default list.
    expect(win.SSH_BIN).toBe(join(binDir, 'ssh.EXE'));
  });

  it('should use the bare name on POSIX, letting spawn search PATH', async () => {
    const posix = await loadServerAs('linux', { PATH: binDir });

    expect(posix.SSH_BIN).toBe('ssh');
    expect(posix.SCP_BIN).toBe('scp');
  });
});

// =============================================================================
// ssh-config value normalization edge cases
//
// extractHostsFromConfig is a pure function over the parser's section array, so
// these feed it shapes that ssh-config can emit but that are awkward to produce
// from config text alone.
// =============================================================================


describe('silent mode', () => {
  it('should suppress debug output when MCP_SILENT is set', async () => {
    const silent = await loadServerAs('linux', { MCP_SILENT: 'true' });
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      silent.debugLog('this must not be written\n');
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('should write debug output when MCP_SILENT is not set', async () => {
    const loud = await loadServerAs('linux', { MCP_SILENT: undefined });
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      loud.debugLog('hello\n');
      expect(writeSpy).toHaveBeenCalledWith('hello\n');
    } finally {
      writeSpy.mockRestore();
    }
  });
});


// =============================================================================
// Windows ProgramData normalization (issue #10)
//
// Claude Desktop launches the extension with a stripped, allow-listed
// environment that omits %ProgramData%. Win32-OpenSSH resolves it at startup to
// find its global config (%ProgramData%\ssh\) and exits 255 with no output when
// it is unset, so every spawned ssh/scp fails while the same command works from
// a normal shell. server.mjs restores the variable at import time; these tests
// pin that behaviour, including that it stays out of the way on POSIX.
// =============================================================================

describe('Windows ProgramData normalization', () => {
  it('should default ProgramData and ALLUSERSPROFILE when both are missing', async () => {
    const win = await loadServerAs('win32', {
      ProgramData: undefined,
      ALLUSERSPROFILE: undefined,
      SystemDrive: 'C:',
    });

    expect(win.envAfterImport.ProgramData).toBe('C:\\ProgramData');
    expect(win.envAfterImport.ALLUSERSPROFILE).toBe('C:\\ProgramData');
  });

  it('should derive the default from %SystemDrive% rather than hardcoding C:', async () => {
    const win = await loadServerAs('win32', {
      ProgramData: undefined,
      ALLUSERSPROFILE: undefined,
      SystemDrive: 'D:',
    });

    expect(win.envAfterImport.ProgramData).toBe('D:\\ProgramData');
  });

  it('should tolerate a %SystemDrive% that carries a trailing separator', async () => {
    const win = await loadServerAs('win32', {
      ProgramData: undefined,
      ALLUSERSPROFILE: undefined,
      SystemDrive: 'E:\\',
    });

    expect(win.envAfterImport.ProgramData).toBe('E:\\ProgramData');
  });

  it('should fall back to C: when %SystemDrive% is missing too', async () => {
    const win = await loadServerAs('win32', {
      ProgramData: undefined,
      ALLUSERSPROFILE: undefined,
      SystemDrive: undefined,
    });

    expect(win.envAfterImport.ProgramData).toBe('C:\\ProgramData');
  });

  it('should prefer an existing ALLUSERSPROFILE over the drive-based default', async () => {
    const win = await loadServerAs('win32', {
      ProgramData: undefined,
      ALLUSERSPROFILE: 'X:\\CustomProgramData',
    });

    expect(win.envAfterImport.ProgramData).toBe('X:\\CustomProgramData');
  });

  it('should leave an already-set ProgramData untouched and backfill ALLUSERSPROFILE', async () => {
    const win = await loadServerAs('win32', {
      ProgramData: 'Q:\\Existing',
      ALLUSERSPROFILE: undefined,
    });

    expect(win.envAfterImport.ProgramData).toBe('Q:\\Existing');
    expect(win.envAfterImport.ALLUSERSPROFILE).toBe('Q:\\Existing');
  });

  it('should not touch either variable when both are already set', async () => {
    const win = await loadServerAs('win32', {
      ProgramData: 'Q:\\Existing',
      ALLUSERSPROFILE: 'R:\\Other',
    });

    expect(win.envAfterImport.ProgramData).toBe('Q:\\Existing');
    expect(win.envAfterImport.ALLUSERSPROFILE).toBe('R:\\Other');
  });

  it('should not invent the variables on POSIX', async () => {
    const posix = await loadServerAs('linux', {
      ProgramData: undefined,
      ALLUSERSPROFILE: undefined,
    });

    expect(posix.envAfterImport.ProgramData).toBeUndefined();
    expect(posix.envAfterImport.ALLUSERSPROFILE).toBeUndefined();
  });

  it('should reach the spawned ssh process through the inherited environment', async () => {
    // The whole point of issue #10: key-auth hosts get no env override, so the
    // child inherits process.env and must find ProgramData there.
    const win = await loadServerAs('win32', {
      ProgramData: undefined,
      ALLUSERSPROFILE: undefined,
      SystemDrive: 'C:',
    });
    const client = new win.SSHClient() as unknown as TestClient;
    win.fs.readFile.mockResolvedValue(`Host test\n    HostName 1.2.3.4\n`);
    client._spawn = createMockSpawn({ stdout: 'ok\n', code: 0 });

    await client.runRemoteCommand('test', 'echo ok');

    // No password -> no explicit env, so the child inherits the parent's, which
    // the import-time normalization has already repaired.
    expect(client._spawn.mock.calls[0][2].env).toBeUndefined();
    expect(win.envAfterImport.ProgramData).toBe('C:\\ProgramData');
  });
});

// =============================================================================
// Defensive paths that only the refactor to explicit modules made reachable
// =============================================================================

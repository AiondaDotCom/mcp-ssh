import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const sshConfigLib = require('ssh-config');

// Mock fs/promises (used via ESM import in server.mjs)
vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
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

import { readFile, stat, writeFile, chmod } from 'node:fs/promises';
import { SSHConfigParser, SSHClient, main, SSH_BIN, SCP_BIN } from './server.js';

// Load a fresh copy of server.mjs with process.platform (and optionally parts of
// the environment) faked, so both the POSIX and the Windows branches can be
// exercised from any host OS. The module snapshots `isWindows`, SSH_BIN and
// SCP_BIN at load time, so the platform only has to stay patched across the
// import itself — hence the restore in `finally`.
//
// Without this, ~14 tests silently assert POSIX-only behaviour (chmod 600
// checks, the /bin/sh askpass helper, `detached`, a bare 'ssh' argv[0]) and fail
// when the suite runs on Windows.
// Variables server.mjs writes to process.env at import time (the Windows
// ProgramData normalization). They are always saved and restored, whether or not
// a test overrides them — otherwise the first Windows-flavoured import leaks its
// mutation into every later test and makes those branches look covered when
// nothing asserted them.
const ENV_MUTATED_AT_IMPORT = ['ProgramData', 'ALLUSERSPROFILE'];

async function loadServerAs(platform, envOverrides = {}) {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const realEnv = {};

  for (const key of ENV_MUTATED_AT_IMPORT) realEnv[key] = process.env[key];

  for (const [key, value] of Object.entries(envOverrides)) {
    realEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  vi.resetModules();

  try {
    const server = await import('./server.js');
    // fs/promises has to be re-imported from the same fresh module graph:
    // resetModules re-runs the vi.mock factory, so these are new spies — not the
    // ones bound by the static import above.
    const fs = await import('node:fs/promises');
    // Snapshot the variables the module writes at import time. The finally block
    // below restores process.env immediately, so a test that wants to assert on
    // the normalization has to read it from here.
    const envAfterImport = Object.fromEntries(
      ENV_MUTATED_AT_IMPORT.map(key => [key, process.env[key]])
    );
    return { ...server, fs, envAfterImport };
  } finally {
    Object.defineProperty(process, 'platform', realPlatform);
    for (const key of new Set([...ENV_MUTATED_AT_IMPORT, ...Object.keys(envOverrides)])) {
      if (realEnv[key] === undefined) delete process.env[key];
      else process.env[key] = realEnv[key];
    }
  }
}

// Helper: create a fake spawn that returns a mock child process
function createMockSpawn({ stdout = '', stderr = '', code = 0, error = null } = {}) {
  return vi.fn(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn(() => {
      setTimeout(() => child.emit('close', null), 2);
    });

    setTimeout(() => {
      if (error) {
        child.emit('error', error);
        return;
      }
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    }, 5);

    return child;
  });
}

// Helper: create a fake execFileAsync
function createMockExecFileAsync({ error = null } = {}) {
  return vi.fn(async () => {
    if (error) throw error;
    return { stdout: '', stderr: '' };
  });
}

const SAMPLE_SSH_CONFIG = `
Host prod
    HostName 157.90.89.149
    Port 42077
    User trashmail

Host mail
    HostName 88.198.170.88
    Port 42078
    User saf
    # @password: killer99

Host nohost
    User nobody
`;

const SAMPLE_SSH_CONFIG_WITH_INCLUDE = `
Include ~/.ssh/configs/*.conf

Host prod
    HostName 157.90.89.149
    User trashmail
`;

const SAMPLE_KNOWN_HOSTS = `157.90.89.149 ssh-ed25519 AAAAC3Nz...
88.198.170.88 ssh-ed25519 AAAAC3Nz...
10.0.0.1 ssh-rsa AAAAB3Nz...
`;

// =============================================================================
// SSHConfigParser Tests
// =============================================================================

describe('SSHConfigParser', () => {
  let parser;

  beforeEach(() => {
    parser = new SSHConfigParser();
    vi.clearAllMocks();
  });

  describe('extractHostsFromConfig', () => {
    it('should parse hosts with hostname, user, port', () => {
      const config = sshConfigLib.parse(SAMPLE_SSH_CONFIG);
      const hosts = parser.extractHostsFromConfig(config, '/home/test/.ssh/config');

      expect(hosts).toHaveLength(2); // nohost has no hostname
      expect(hosts[0]).toMatchObject({
        alias: 'prod',
        hostname: '157.90.89.149',
        port: 42077,
        user: 'trashmail',
      });
    });

    it('should parse @password annotation from comments', () => {
      const config = sshConfigLib.parse(SAMPLE_SSH_CONFIG);
      const hosts = parser.extractHostsFromConfig(config, '/test');
      const mail = hosts.find(h => h.alias === 'mail');
      expect(mail._password).toBe('killer99');
    });

    it('should handle password with colons', () => {
      const config = sshConfigLib.parse(`
Host test
    HostName 1.2.3.4
    # @password:pass:with:colons
`);
      const hosts = parser.extractHostsFromConfig(config, '/test');
      expect(hosts[0]._password).toBe('pass:with:colons');
    });

    it('should handle password with spaces after colon', () => {
      const config = sshConfigLib.parse(`
Host test
    HostName 1.2.3.4
    # @password: spaced
`);
      const hosts = parser.extractHostsFromConfig(config, '/test');
      expect(hosts[0]._password).toBe('spaced');
    });

    it('should skip hosts without hostname', () => {
      const config = sshConfigLib.parse(SAMPLE_SSH_CONFIG);
      const hosts = parser.extractHostsFromConfig(config, '/test');
      expect(hosts.find(h => h.alias === 'nohost')).toBeUndefined();
    });

    it('should skip wildcard host', () => {
      const config = sshConfigLib.parse(`
Host *
    ServerAliveInterval 55

Host myhost
    HostName 1.2.3.4
`);
      const hosts = parser.extractHostsFromConfig(config, '/test');
      expect(hosts).toHaveLength(1);
      expect(hosts[0].alias).toBe('myhost');
    });

    // Regression: ssh-config@5 returns a plain string for a single-token value
    // but an array of token objects for `Host a b`. Storing that array in
    // `alias` made every strict comparison fail, so a multi-alias host was
    // unreachable under *any* of its names.
    it('should expose every alias of a multi-alias Host block', () => {
      const config = sshConfigLib.parse(`
Host docker-lxc hlab
    HostName 10.9.0.105
    User root
`);
      const hosts = parser.extractHostsFromConfig(config, '/test');

      expect(hosts).toHaveLength(1);
      expect(hosts[0].aliases).toEqual(['docker-lxc', 'hlab']);
      expect(hosts[0].alias).toBe('docker-lxc');
      expect(hosts[0].hostname).toBe('10.9.0.105');
    });

    it('should keep alias a string for single-alias hosts', () => {
      const config = sshConfigLib.parse(`
Host solo
    HostName 1.2.3.4
`);
      const hosts = parser.extractHostsFromConfig(config, '/test');

      expect(hosts[0].alias).toBe('solo');
      expect(hosts[0].aliases).toEqual(['solo']);
    });

    it('should skip a wildcard block carrying negations', () => {
      const config = sshConfigLib.parse(`
Host * !bastion
    HostName 7.7.7.7

Host myhost
    HostName 1.2.3.4
`);
      const hosts = parser.extractHostsFromConfig(config, '/test');

      expect(hosts).toHaveLength(1);
      expect(hosts[0].alias).toBe('myhost');
    });

    it('should flatten multi-token directives into a string', () => {
      const config = sshConfigLib.parse(`
Host jump
    HostName localhost
    ProxyCommand ssh bastion -W %h:%p
`);
      const hosts = parser.extractHostsFromConfig(config, '/test');

      expect(hosts[0].proxycommand).toBe('ssh bastion -W %h:%p');
    });

    it('should skip Include directives', () => {
      const config = sshConfigLib.parse(SAMPLE_SSH_CONFIG_WITH_INCLUDE);
      const hosts = parser.extractHostsFromConfig(config, '/test');
      expect(hosts).toHaveLength(1);
      expect(hosts[0].alias).toBe('prod');
    });

    it('should parse identityFile', () => {
      const config = sshConfigLib.parse(`
Host test
    HostName 1.2.3.4
    IdentityFile ~/.ssh/id_rsa
`);
      const hosts = parser.extractHostsFromConfig(config, '/test');
      expect(hosts[0].identityFile).toBe('~/.ssh/id_rsa');
    });

    it('should store other parameters in lowercase', () => {
      const config = sshConfigLib.parse(`
Host test
    HostName 1.2.3.4
    ProxyJump bastion
`);
      const hosts = parser.extractHostsFromConfig(config, '/test');
      expect(hosts.proxyjump || hosts[0].proxyjump).toBe('bastion');
    });

    it('should track configs with passwords', () => {
      const config = sshConfigLib.parse(`
Host test
    HostName 1.2.3.4
    # @password:secret
`);
      parser.extractHostsFromConfig(config, '/my/config');
      expect(parser._configsWithPasswords.has('/my/config')).toBe(true);
    });

    it('should not track configs without passwords', () => {
      const config = sshConfigLib.parse(`
Host test
    HostName 1.2.3.4
`);
      parser.extractHostsFromConfig(config, '/my/config');
      expect(parser._configsWithPasswords).toBeUndefined();
    });

    it('should ignore comment lines that are not @password', () => {
      const config = sshConfigLib.parse(`
Host test
    HostName 1.2.3.4
    # This is a regular comment
    # Another comment
`);
      const hosts = parser.extractHostsFromConfig(config, '/test');
      expect(hosts[0]._password).toBeUndefined();
    });
  });

  describe('parseConfig', () => {
    it('should parse SSH config file', async () => {
      readFile.mockResolvedValue(SAMPLE_SSH_CONFIG);
      const hosts = await parser.parseConfig();
      expect(hosts).toHaveLength(2);
    });

    it('should return empty array on read error', async () => {
      readFile.mockRejectedValue(new Error('ENOENT'));
      const hosts = await parser.parseConfig();
      expect(hosts).toEqual([]);
    });
  });

  describe('parseKnownHosts', () => {
    it('should parse known_hosts file', async () => {
      readFile.mockResolvedValue(SAMPLE_KNOWN_HOSTS);
      const hosts = await parser.parseKnownHosts();
      expect(hosts).toEqual(['157.90.89.149', '88.198.170.88', '10.0.0.1']);
    });

    it('should return empty array on read error', async () => {
      readFile.mockRejectedValue(new Error('ENOENT'));
      const hosts = await parser.parseKnownHosts();
      expect(hosts).toEqual([]);
    });

    it('should skip empty lines', async () => {
      readFile.mockResolvedValue('host1 ssh-rsa key\n\n\nhost2 ssh-rsa key\n');
      const hosts = await parser.parseKnownHosts();
      expect(hosts).toEqual(['host1', 'host2']);
    });

    it('should handle comma-separated hostnames', async () => {
      readFile.mockResolvedValue('host1,host2 ssh-rsa key\n');
      const hosts = await parser.parseKnownHosts();
      expect(hosts).toEqual(['host1']);
    });
  });

  // Unix permission bits have no meaning on Windows, so checkFilePermissions is
  // a deliberate no-op there. Pin the platform instead of inheriting the host's,
  // otherwise every expectation below is wrong on one OS or the other.
  describe('checkFilePermissions (POSIX)', () => {
    let posixParser;
    let posixStat;

    beforeEach(async () => {
      const posix = await loadServerAs('linux');
      posixParser = new posix.SSHConfigParser();
      posixStat = posix.fs.stat;
    });

    it('should pass with 600 permissions', async () => {
      posixStat.mockResolvedValue({ mode: 0o100600 });
      await expect(posixParser.checkFilePermissions('/test')).resolves.not.toThrow();
    });

    it('should throw on insecure permissions (644)', async () => {
      posixStat.mockResolvedValue({ mode: 0o100644 });
      await expect(posixParser.checkFilePermissions('/test')).rejects.toThrow('insecure permissions');
    });

    it('should throw on insecure permissions (755)', async () => {
      posixStat.mockResolvedValue({ mode: 0o100755 });
      await expect(posixParser.checkFilePermissions('/test')).rejects.toThrow('insecure permissions');
    });

    it('should include chmod hint in error message', async () => {
      posixStat.mockResolvedValue({ mode: 0o100644 });
      await expect(posixParser.checkFilePermissions('/test')).rejects.toThrow('chmod 600');
    });

    it('should ignore ENOENT errors', async () => {
      const err = new Error('not found');
      err.code = 'ENOENT';
      posixStat.mockRejectedValue(err);
      await expect(posixParser.checkFilePermissions('/test')).resolves.not.toThrow();
    });

    it('should rethrow other errors', async () => {
      posixStat.mockRejectedValue(new Error('disk failure'));
      await expect(posixParser.checkFilePermissions('/test')).rejects.toThrow('disk failure');
    });
  });

  describe('checkFilePermissions (Windows)', () => {
    it('should skip the permission check without touching stat', async () => {
      const win = await loadServerAs('win32');
      const winParser = new win.SSHConfigParser();
      win.fs.stat.mockResolvedValue({ mode: 0o100777 });

      await expect(winParser.checkFilePermissions('C:\\Users\\test\\.ssh\\config')).resolves.toBeUndefined();
      expect(win.fs.stat).not.toHaveBeenCalled();
    });
  });

  describe('getAllKnownHosts', () => {
    it('should merge config hosts and known_hosts, deduplicating', async () => {
      readFile
        .mockResolvedValueOnce(SAMPLE_SSH_CONFIG)
        .mockResolvedValueOnce(SAMPLE_KNOWN_HOSTS);
      stat.mockResolvedValue({ mode: 0o100600 });

      const hosts = await parser.getAllKnownHosts();

      const configHosts = hosts.filter(h => h.source === 'ssh_config');
      const knownHosts = hosts.filter(h => h.source === 'known_hosts');

      expect(configHosts).toHaveLength(2);
      expect(knownHosts).toHaveLength(1);
      expect(knownHosts[0].hostname).toBe('10.0.0.1');
    });

    // POSIX-pinned: the permission check is a no-op on Windows (see above), so
    // asserting that stat() ran only makes sense for the POSIX build.
    it('should check permissions for configs with passwords', async () => {
      const posix = await loadServerAs('linux');
      const posixParser = new posix.SSHConfigParser();
      posix.fs.readFile
        .mockResolvedValueOnce(SAMPLE_SSH_CONFIG)
        .mockResolvedValueOnce(SAMPLE_KNOWN_HOSTS);
      posix.fs.stat.mockResolvedValue({ mode: 0o100600 });

      await posixParser.getAllKnownHosts();
      expect(posix.fs.stat).toHaveBeenCalled();
    });

    it('should work with empty known_hosts', async () => {
      readFile
        .mockResolvedValueOnce(SAMPLE_SSH_CONFIG)
        .mockRejectedValueOnce(new Error('ENOENT'));
      stat.mockResolvedValue({ mode: 0o100600 });

      const hosts = await parser.getAllKnownHosts();
      expect(hosts).toHaveLength(2);
    });
  });

  describe('processIncludeDirectives', () => {
    it('should return empty array on read error', async () => {
      readFile.mockRejectedValue(new Error('ENOENT'));
      const hosts = await parser.processIncludeDirectives('/nonexistent');
      expect(hosts).toEqual([]);
    });

    it('should parse config without includes', async () => {
      readFile.mockResolvedValue(SAMPLE_SSH_CONFIG);
      const hosts = await parser.processIncludeDirectives('/test/.ssh/config');
      expect(hosts).toHaveLength(2);
    });

    it('should process Include directives and merge hosts', async () => {
      const mainConfig = `
Include /tmp/included.conf

Host main
    HostName 1.2.3.4
`;
      const includedConfig = `
Host included
    HostName 5.6.7.8
`;
      readFile
        .mockResolvedValueOnce(mainConfig)
        .mockResolvedValueOnce(includedConfig);

      // Mock expandIncludePath to return the include path
      parser.expandIncludePath = vi.fn().mockReturnValue(['/tmp/included.conf']);

      const hosts = await parser.processIncludeDirectives('/test/.ssh/config');
      expect(hosts).toHaveLength(2);
      expect(hosts.map(h => h.alias)).toContain('included');
      expect(hosts.map(h => h.alias)).toContain('main');
    });

    it('should handle errors in included files gracefully', async () => {
      const mainConfig = `
Include /tmp/broken.conf

Host main
    HostName 1.2.3.4
`;
      // First call reads main config, second call for included file rejects
      // processIncludeDirectives catches this internally and returns []
      readFile
        .mockResolvedValueOnce(mainConfig)
        .mockRejectedValueOnce(new Error('permission denied'));

      parser.expandIncludePath = vi.fn().mockReturnValue(['/tmp/broken.conf']);

      const hosts = await parser.processIncludeDirectives('/test/.ssh/config');
      // Should still return hosts from main config (included returns [] on error)
      expect(hosts).toHaveLength(1);
      expect(hosts[0].alias).toBe('main');
    });
  });

  describe('expandIncludePath', () => {
    it('should expand tilde paths', () => {
      const result = parser.expandIncludePath('~/nonexistent-path-xyz', '/base');
      expect(result).toEqual([]);
    });

    it('should handle relative paths', () => {
      const result = parser.expandIncludePath('relative/path', '/base/config');
      expect(result).toEqual([]);
    });

    it('should return empty for non-existent absolute paths', () => {
      const result = parser.expandIncludePath('/nonexistent-absolute-path-xyz', '/base');
      expect(result).toEqual([]);
    });

    it('should treat Windows drive-letter paths as absolute', () => {
      const result = parser.expandIncludePath('C:\\nonexistent-absolute-path-xyz', '/base/config');
      expect(result).toEqual([]);
    });

    it('should treat UNC paths as absolute', () => {
      const result = parser.expandIncludePath('\\\\server\\share\\nonexistent-path-xyz', '/base/config');
      expect(result).toEqual([]);
    });

    it('should expand tilde paths with backslashes', () => {
      const result = parser.expandIncludePath('~\\nonexistent-path-xyz', '/base');
      expect(result).toEqual([]);
    });

    it('should return empty for non-existent glob patterns', () => {
      const result = parser.expandIncludePath('/nonexistent-path-xyz/*.conf', '/base');
      expect(result).toEqual([]);
    });

    it('should handle errors in glob/existsSync gracefully', () => {
      vi.mocked(existsSync).mockImplementationOnce(() => { throw new Error('fs broken'); });

      const result = parser.expandIncludePath('/some/path/file', '/base');
      expect(result).toEqual([]);
    });
  });
});

// =============================================================================
// SSHClient Tests
// =============================================================================

describe('SSHClient', () => {
  let client;

  beforeEach(() => {
    client = new SSHClient();
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
    let posixClient;
    let posixFs;

    beforeEach(async () => {
      const posix = await loadServerAs('linux');
      posixClient = new posix.SSHClient();
      posixFs = posix.fs;
      posixFs.writeFile.mockResolvedValue();
      posixFs.chmod.mockResolvedValue();
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
        '#!/bin/sh\necho "$MCP_SSH_PASS"\n'
      );
    });

    it('should use a .sh extension', async () => {
      const scriptPath = await posixClient.getAskpassScript();
      expect(scriptPath).toMatch(/mcp-ssh-askpass-\d+\.sh$/);
    });
  });

  describe('getAskpassScript (Windows)', () => {
    let winClient;
    let winFs;

    beforeEach(async () => {
      const win = await loadServerAs('win32');
      winClient = new win.SSHClient();
      winFs = win.fs;
      winFs.writeFile.mockResolvedValue();
      winFs.chmod.mockResolvedValue();
    });

    it('should write a .cmd batch file with CRLF line endings', async () => {
      const scriptPath = await winClient.getAskpassScript();

      expect(scriptPath).toMatch(/mcp-ssh-askpass-\d+\.cmd$/);
      expect(winFs.writeFile).toHaveBeenCalledWith(
        scriptPath,
        '@echo off\r\necho %MCP_SSH_PASS%\r\n'
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
      writeFile.mockResolvedValue();
      chmod.mockResolvedValue();

      const env = await client.buildSpawnEnv('mail');
      expect(env.MCP_SSH_PASS).toBe('killer99');
      expect(env.SSH_ASKPASS).toContain('mcp-ssh-askpass');
      expect(env.SSH_ASKPASS_REQUIRE).toBe('force');
      expect(env.DISPLAY).toBe(process.env.DISPLAY);
    });

    // POSIX-pinned: relies on the permission check, which is a no-op on Windows.
    it('should throw if config has insecure permissions', async () => {
      const posix = await loadServerAs('linux');
      const posixClient = new posix.SSHClient();
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
        const child = new EventEmitter();
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
      const posixClient = new posix.SSHClient();
      posix.fs.readFile.mockResolvedValue(SAMPLE_SSH_CONFIG);
      posix.fs.stat.mockResolvedValue({ mode: 0o100600 });
      posix.fs.writeFile.mockResolvedValue();
      posix.fs.chmod.mockResolvedValue();
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
      const winClient = new win.SSHClient();
      win.fs.readFile.mockResolvedValue(SAMPLE_SSH_CONFIG);
      win.fs.writeFile.mockResolvedValue();
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
        const child = new EventEmitter();
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
        const child = new EventEmitter();
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
        ['-o', 'StrictHostKeyChecking=accept-new', '--', '/local/file', 'test:/remote/file'],
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
      writeFile.mockResolvedValue();
      chmod.mockResolvedValue();
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
        ['-o', 'StrictHostKeyChecking=accept-new', '--', 'test:/remote/file', '/local/file'],
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
        const child = new EventEmitter();
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
        const child = new EventEmitter();
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

describe('MCP Server Handlers', () => {
  let server;
  let handlers;
  let clientSpies;

  afterEach(() => {
    for (const spy of clientSpies) spy.mockRestore();
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    // These tests drive the real SSHClient that main() constructs, so every tool
    // call would otherwise spawn an actual ssh/scp process against 1.2.3.4 and
    // block on the network. Stubbing the three process-starting methods keeps
    // the block a dispatch test — which is all it asserts — instead of a slow,
    // network-dependent one that blows the 5s timeout on Windows CI runners.
    // The methods themselves are covered by the SSHClient tests above.
    clientSpies = [
      vi.spyOn(SSHClient.prototype, 'runRemoteCommand')
        .mockResolvedValue({ stdout: 'connected', stderr: '', code: 0 }),
      vi.spyOn(SSHClient.prototype, 'uploadFile').mockResolvedValue(true),
      vi.spyOn(SSHClient.prototype, 'downloadFile').mockResolvedValue(true),
    ];

    // Capture the request handlers that main() registers
    handlers = {};

    // Mock the MCP SDK Server and Transport
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
    const sdkTypes = await import('@modelcontextprotocol/sdk/types.js');

    // Save original and mock
    const origSetRequestHandler = Server.prototype.setRequestHandler;
    const origConnect = Server.prototype.connect;

    Server.prototype.setRequestHandler = function(schema, handler) {
      // Store by schema name
      if (schema === sdkTypes.ListToolsRequestSchema) {
        handlers.listTools = handler;
      } else if (schema === sdkTypes.CallToolRequestSchema) {
        handlers.callTool = handler;
      }
    };
    Server.prototype.connect = vi.fn().mockResolvedValue();

    readFile.mockResolvedValue(SAMPLE_SSH_CONFIG);
    stat.mockResolvedValue({ mode: 0o100600 });

    await main();

    // Restore
    Server.prototype.setRequestHandler = origSetRequestHandler;
    Server.prototype.connect = origConnect;
  });

  it('should register listTools handler that returns all tools', async () => {
    const result = await handlers.listTools();
    expect(result.tools).toHaveLength(7);
    const names = result.tools.map(t => t.name);
    expect(names).toContain('listKnownHosts');
    expect(names).toContain('runRemoteCommand');
    expect(names).toContain('getHostInfo');
    expect(names).toContain('checkConnectivity');
    expect(names).toContain('uploadFile');
    expect(names).toContain('downloadFile');
    expect(names).toContain('runCommandBatch');
  });

  it('should handle listKnownHosts tool call', async () => {
    readFile
      .mockResolvedValueOnce(SAMPLE_SSH_CONFIG)
      .mockResolvedValueOnce(SAMPLE_KNOWN_HOSTS);

    const result = await handlers.callTool({
      params: { name: 'listKnownHosts', arguments: {} }
    });

    const hosts = JSON.parse(result.content[0].text);
    expect(Array.isArray(hosts)).toBe(true);
    // Passwords should be stripped
    for (const host of hosts) {
      expect(host._password).toBeUndefined();
    }
  });

  it('should handle getHostInfo tool call', async () => {
    readFile.mockResolvedValue(SAMPLE_SSH_CONFIG);

    const result = await handlers.callTool({
      params: { name: 'getHostInfo', arguments: { hostAlias: 'mail' } }
    });

    const info = JSON.parse(result.content[0].text);
    expect(info.alias).toBe('mail');
    expect(info._password).toBeUndefined();
    expect(info.passwordAuth).toBe(true);
  });

  it('should throw on missing arguments', async () => {
    await expect(
      handlers.callTool({ params: { name: 'runRemoteCommand', arguments: undefined } })
    ).rejects.toThrow('No arguments provided');
  });

  it('should handle unknown tool name', async () => {
    const result = await handlers.callTool({
      params: { name: 'unknownTool', arguments: {} }
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain('Unknown tool');
  });

  it('should cap runRemoteCommand timeout at 300000ms', async () => {
    readFile.mockResolvedValue(`Host test\n    HostName 1.2.3.4\n`);
    const spy = vi.spyOn(SSHClient.prototype, 'runRemoteCommand')
      .mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    try {
      await handlers.callTool({
        params: {
          name: 'runRemoteCommand',
          arguments: { hostAlias: 'test', command: 'echo hi', timeout: 999999 }
        }
      });

      expect(spy).toHaveBeenCalledWith('test', 'echo hi', { timeout: 300000 });
    } finally {
      spy.mockRestore();
    }
  });

  it('should default the runRemoteCommand timeout to 120000ms', async () => {
    readFile.mockResolvedValue(`Host test\n    HostName 1.2.3.4\n`);
    const spy = vi.spyOn(SSHClient.prototype, 'runRemoteCommand')
      .mockResolvedValue({ stdout: '', stderr: '', code: 0 });

    try {
      await handlers.callTool({
        params: { name: 'runRemoteCommand', arguments: { hostAlias: 'test', command: 'echo hi' } }
      });

      expect(spy).toHaveBeenCalledWith('test', 'echo hi', { timeout: 120000 });
    } finally {
      spy.mockRestore();
    }
  });

  it('should stringify non-Error values thrown by a tool', async () => {
    const spy = vi.spyOn(SSHClient.prototype, 'listKnownHosts')
      .mockRejectedValue('a bare string, not an Error');

    try {
      const result = await handlers.callTool({
        params: { name: 'listKnownHosts', arguments: {} }
      });

      expect(JSON.parse(result.content[0].text).error).toBe('a bare string, not an Error');
    } finally {
      spy.mockRestore();
    }
  });

  it('should handle checkConnectivity tool call', async () => {
    readFile.mockResolvedValue(`Host test\n    HostName 1.2.3.4\n`);

    const result = await handlers.callTool({
      params: { name: 'checkConnectivity', arguments: { hostAlias: 'test' } }
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveProperty('connected');
    expect(parsed).toHaveProperty('message');
  });

  it('should handle uploadFile tool call', async () => {
    readFile.mockResolvedValue(`Host test\n    HostName 1.2.3.4\n`);

    const result = await handlers.callTool({
      params: {
        name: 'uploadFile',
        arguments: { hostAlias: 'test', localPath: '/tmp/test', remotePath: '/tmp/dest' }
      }
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveProperty('success');
  });

  it('should handle downloadFile tool call', async () => {
    readFile.mockResolvedValue(`Host test\n    HostName 1.2.3.4\n`);

    const result = await handlers.callTool({
      params: {
        name: 'downloadFile',
        arguments: { hostAlias: 'test', remotePath: '/tmp/src', localPath: '/tmp/dest' }
      }
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveProperty('success');
  });

  it('should handle runCommandBatch tool call', async () => {
    readFile.mockResolvedValue(`Host test\n    HostName 1.2.3.4\n`);

    const result = await handlers.callTool({
      params: {
        name: 'runCommandBatch',
        arguments: { hostAlias: 'test', commands: ['echo a', 'echo b'] }
      }
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveProperty('results');
    expect(parsed).toHaveProperty('success');
  });

  it('should allow listKnownHosts without arguments', async () => {
    readFile
      .mockResolvedValueOnce(SAMPLE_SSH_CONFIG)
      .mockResolvedValueOnce(SAMPLE_KNOWN_HOSTS);

    const result = await handlers.callTool({
      params: { name: 'listKnownHosts' }
    });

    const hosts = JSON.parse(result.content[0].text);
    expect(Array.isArray(hosts)).toBe(true);
  });
});

// =============================================================================
// main() error handling
// =============================================================================

describe('main() error handling', () => {
  it('should handle startup errors gracefully', async () => {
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
    const origConnect = Server.prototype.connect;

    Server.prototype.connect = vi.fn().mockRejectedValue(new Error('transport failed'));

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});

    await main();

    expect(exitSpy).toHaveBeenCalledWith(1);

    Server.prototype.connect = origConnect;
    exitSpy.mockRestore();
  });
});

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
  let binDir;

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

describe('config value normalization', () => {
  let parser;

  beforeEach(() => {
    parser = new SSHConfigParser();
    vi.clearAllMocks();
  });

  it('should treat a directive without a value as absent', () => {
    const hosts = parser.extractHostsFromConfig([
      {
        param: 'Host',
        value: 'x',
        config: [
          { param: 'HostName', value: '1.2.3.4' },
          { param: 'SendEnv', value: null },
        ],
      },
    ], '/test');

    expect(hosts).toHaveLength(1);
    expect(hosts[0].sendenv).toBe('');
  });

  it('should accept plain strings inside a multi-token value', () => {
    // ssh-config normally yields {val,…} token objects, but a hand-built or
    // future-shaped array of bare strings must normalize the same way.
    const hosts = parser.extractHostsFromConfig([
      {
        param: 'Host',
        value: ['first', 'second'],
        config: [{ param: 'HostName', value: '1.2.3.4' }],
      },
    ], '/test');

    expect(hosts[0].aliases).toEqual(['first', 'second']);
    expect(hosts[0].alias).toBe('first');
  });

  it('should skip a Host block whose value is empty', () => {
    const hosts = parser.extractHostsFromConfig([
      { param: 'Host', value: [], config: [{ param: 'HostName', value: '1.2.3.4' }] },
    ], '/test');

    expect(hosts).toEqual([]);
  });

  it('should ignore top-level directives that are not Host or Include', () => {
    const config = sshConfigLib.parse(`
ServerAliveInterval 30

Host real
    HostName 1.2.3.4
`);
    const hosts = parser.extractHostsFromConfig(config, '/test');

    expect(hosts).toHaveLength(1);
    expect(hosts[0].alias).toBe('real');
  });
});

// =============================================================================
// expandIncludePath — paths that actually exist
// =============================================================================

describe('expandIncludePath (existing paths)', () => {
  let parser;
  let dir;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-ssh-inc-'));
    writeFileSync(join(dir, 'included.conf'), 'Host inc\n    HostName 5.5.5.5\n');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    parser = new SSHConfigParser();
  });

  it('should return an existing absolute path', () => {
    const target = join(dir, 'included.conf');
    expect(parser.expandIncludePath(target, '/base/config')).toEqual([target]);
  });

  it('should expand a glob pattern to the files it matches', () => {
    // glob patterns are forward-slash based on every platform, including Windows.
    const pattern = `${dir.replace(/\\/g, '/')}/*.conf`;
    const result = parser.expandIncludePath(pattern, '/base/config');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatch(/included\.conf$/);
  });
});

// =============================================================================
// Remaining branches: argument validation, known_hosts matching, silent mode,
// askpass cleanup handlers and the tool-dispatch catch-all.
// =============================================================================

describe('_assertSafeHostAlias argument validation', () => {
  let client;

  beforeEach(() => {
    client = new SSHClient();
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
  let client;

  beforeEach(() => {
    client = new SSHClient();
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

describe('askpass script cleanup handlers', () => {
  let client;
  let exitSpy;

  beforeEach(async () => {
    vi.clearAllMocks();
    writeFile.mockResolvedValue();
    chmod.mockResolvedValue();
    client = new SSHClient();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
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
    const handler = listeners[listeners.length - 1];
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
  let client;

  beforeEach(() => {
    client = new SSHClient();
    vi.clearAllMocks();
    readFile.mockResolvedValue(SAMPLE_SSH_CONFIG);
    stat.mockResolvedValue({ mode: 0o100600 });
    writeFile.mockResolvedValue();
    chmod.mockResolvedValue();
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
  let client;

  beforeEach(() => {
    client = new SSHClient();
    vi.clearAllMocks();
    readFile.mockResolvedValue(`Host test\n    HostName 1.2.3.4\n`);
  });

  // Three chunks: the second crosses the limit and appends the marker, the third
  // must be dropped silently rather than appending it again.
  function spawnEmitting(stream, chunks) {
    return vi.fn(() => {
      const child = new EventEmitter();
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
    const client = new win.SSHClient();
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

describe('non-Error failures', () => {
  let parser;

  beforeEach(() => {
    parser = new SSHConfigParser();
    vi.clearAllMocks();
  });

  it('should stringify a non-Error rejection while reading the config', async () => {
    readFile.mockRejectedValue('not an Error object');

    // Reaches the String(error) side of the shared error formatter.
    await expect(parser.parseConfig()).resolves.toEqual([]);
  });

  it('should stringify a non-Error thrown during startup', async () => {
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
    const origConnect = Server.prototype.connect;
    Server.prototype.connect = vi.fn().mockRejectedValue('transport exploded');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});

    try {
      await main();
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      Server.prototype.connect = origConnect;
      exitSpy.mockRestore();
    }
  });
});

describe('parser edge shapes', () => {
  let parser;

  beforeEach(() => {
    parser = new SSHConfigParser();
    vi.clearAllMocks();
  });

  it('should handle a Host section that carries no directives at all', () => {
    // `Host x` with nothing under it: ssh-config still yields a section, and it
    // has no `config` array to walk.
    const hosts = parser.extractHostsFromConfig([{ param: 'Host', value: 'bare' }], '/test');
    expect(hosts).toEqual([]);
  });
});

describe('remote command exit codes', () => {
  let client;

  beforeEach(() => {
    client = new SSHClient();
    vi.clearAllMocks();
    readFile.mockResolvedValue(`Host test\n    HostName 1.2.3.4\n`);
  });

  it('should report code 0 when the process closes with a null code', async () => {
    // ssh killed by a signal exits with a null code and no timeout involved.
    client._spawn = vi.fn(() => {
      const child = new EventEmitter();
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

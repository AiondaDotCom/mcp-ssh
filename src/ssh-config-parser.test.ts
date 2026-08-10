import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import type { Mock } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sshConfigLib = require('ssh-config');

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

import { SSHConfigParser } from './server.js';
import {
  readFile,
  stat,
  loadServerAs,
  SAMPLE_SSH_CONFIG,
  SAMPLE_SSH_CONFIG_WITH_INCLUDE,
  SAMPLE_KNOWN_HOSTS,
} from './test-helpers.js';


// =============================================================================
// SSHConfigParser Tests
// =============================================================================

describe('SSHConfigParser', () => {
  let parser: SSHConfigParser;

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
      expect(hosts[0].proxyjump).toBe('bastion');
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
    let posixParser: SSHConfigParser;
    let posixStat: Mock;

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
      const err: NodeJS.ErrnoException = new Error('not found');
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


// =============================================================================
// ssh-config value normalization edge cases
//
// extractHostsFromConfig is a pure function over the parser's section array, so
// these feed it shapes that ssh-config can emit but that are awkward to produce
// from config text alone.
// =============================================================================

describe('config value normalization', () => {
  let parser: SSHConfigParser;

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


// =============================================================================
// expandIncludePath — paths that actually exist
// =============================================================================

describe('expandIncludePath (existing paths)', () => {
  let parser: SSHConfigParser;
  let dir: string;

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


describe('parser edge shapes', () => {
  let parser: SSHConfigParser;

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

describe('Include recursion is bounded', () => {
  let parser: SSHConfigParser;

  beforeEach(() => {
    parser = new SSHConfigParser();
    vi.clearAllMocks();
  });

  it('should terminate on a config that includes itself', async () => {
    // Without a cycle guard this recurses until the stack blows. The config is
    // the user's own file, so this is robustness rather than an LLM-reachable
    // bug — but it becomes reachable if anything can write that file.
    readFile.mockResolvedValue('Include /tmp/self.conf\n\nHost real\n    HostName 1.2.3.4\n');
    parser.expandIncludePath = vi.fn(() => ['/tmp/self.conf']);

    const hosts = await parser.processIncludeDirectives('/tmp/self.conf');

    expect(Array.isArray(hosts)).toBe(true);
    expect(hosts.some(h => h.alias === 'real')).toBe(true);
  }, 10000);

  it('should terminate on a two-file include cycle', async () => {
    readFile.mockImplementation(async (p: unknown) =>
      String(p).endsWith('a.conf')
        ? 'Include /tmp/b.conf\nHost a\n    HostName 1.1.1.1\n'
        : 'Include /tmp/a.conf\nHost b\n    HostName 2.2.2.2\n'
    );
    parser.expandIncludePath = vi.fn((inc: string) => [inc]);

    const hosts = await parser.processIncludeDirectives('/tmp/a.conf');

    expect(Array.isArray(hosts)).toBe(true);
  }, 10000);
});

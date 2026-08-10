import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';

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

import { SSHConfigParser, SSHClient, main } from './server.js';
import {
  readFile,
  stat,
  SAMPLE_SSH_CONFIG,
  SAMPLE_KNOWN_HOSTS,
} from './test-helpers.js';


// =============================================================================
// MCP Server Handler Tests (via main())
// =============================================================================

describe('MCP Server Handlers', () => {
  let handlers: Record<string, (...args: any[]) => any>;
  let clientSpies: MockInstance[];

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

    Server.prototype.setRequestHandler = function(schema: unknown, handler: (...args: any[]) => any) {
      // Store by schema name
      if (schema === sdkTypes.ListToolsRequestSchema) {
        handlers.listTools = handler;
      } else if (schema === sdkTypes.CallToolRequestSchema) {
        handlers.callTool = handler;
      }
    };
    Server.prototype.connect = vi.fn().mockResolvedValue(undefined);

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


// =============================================================================
// main() error handling
// =============================================================================

describe('main() error handling', () => {
  it('should handle startup errors gracefully', async () => {
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
    const origConnect = Server.prototype.connect;

    Server.prototype.connect = vi.fn().mockRejectedValue(new Error('transport failed'));

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

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


// =============================================================================
// Defensive paths that only the refactor to explicit modules made reachable
// =============================================================================

describe('non-Error failures', () => {
  let parser: SSHConfigParser;

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
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    try {
      await main();
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      Server.prototype.connect = origConnect;
      exitSpy.mockRestore();
    }
  });
});

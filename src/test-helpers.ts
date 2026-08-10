/**
 * Shared fixtures and helpers for the test suite.
 *
 * The vi.mock() calls for node:fs and node:fs/promises are NOT here: vitest
 * scopes module mocks to the test file that declares them, so every test file
 * repeats them and this module then sees the mocked copies.
 */
import { vi } from 'vitest';
import type { Mock } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fsPromises from 'node:fs/promises';

import { SSHConfigParser, SSHClient, main } from './server.js';

export const readFile = fsPromises.readFile as unknown as Mock;
export const stat = fsPromises.stat as unknown as Mock;
export const writeFile = fsPromises.writeFile as unknown as Mock;
export const chmod = fsPromises.chmod as unknown as Mock;

/** A stand-in for ChildProcess: an emitter with the streams bolted on. */
export interface MockChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: Mock;
}

/** The fs/promises functions this suite mocks, as vitest sees them. */
export interface MockedFs {
  readFile: Mock;
  stat: Mock;
  writeFile: Mock;
  chmod: Mock;
  unlink: Mock;
}

/** SSHClient with its spawn/execFile injection points seen as plain mocks. */
export type TestClient = Omit<SSHClient, '_spawn' | '_execFileAsync'> & {
  _spawn: Mock;
  _execFileAsync: Mock;
};

export type SpawnMock = Mock;
export type ExecFileMock = Mock;

// Without this, ~14 tests silently assert POSIX-only behaviour (chmod 600
// checks, the /bin/sh askpass helper, `detached`, a bare 'ssh' argv[0]) and fail
// when the suite runs on Windows.
// Variables server.mjs writes to process.env at import time (the Windows
// ProgramData normalization). They are always saved and restored, whether or not
// a test overrides them — otherwise the first Windows-flavoured import leaks its
// mutation into every later test and makes those branches look covered when
// nothing asserted them.
export const ENV_MUTATED_AT_IMPORT = ['ProgramData', 'ALLUSERSPROFILE'];

/** What a re-imported copy of the server module graph exposes to a test. */
export interface LoadedServer {
  SSHClient: typeof SSHClient;
  SSHConfigParser: typeof SSHConfigParser;
  main: typeof main;
  debugLog: (message: string) => void;
  SSH_BIN: string;
  SCP_BIN: string;
  fs: MockedFs;
  envAfterImport: Record<string, string | undefined>;
}

export async function loadServerAs(
  platform: string,
  envOverrides: Record<string, string | undefined> = {},
): Promise<LoadedServer> {
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
    return { ...server, fs, envAfterImport } as unknown as LoadedServer;
  } finally {
    Object.defineProperty(process, 'platform', realPlatform);
    for (const key of new Set([...ENV_MUTATED_AT_IMPORT, ...Object.keys(envOverrides)])) {
      if (realEnv[key] === undefined) delete process.env[key];
      else process.env[key] = realEnv[key];
    }
  }
}

// Helper: create a fake spawn that returns a mock child process
export function createMockSpawn({ stdout = '', stderr = '', code = 0, error = null } = {}): SpawnMock {
  return vi.fn(() => {
    const child = new EventEmitter() as MockChild;
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
  }) as unknown as SpawnMock;
}

// Helper: create a fake execFileAsync
export function createMockExecFileAsync({ error = null } = {}): ExecFileMock {
  return vi.fn(async () => {
    if (error) throw error;
    return { stdout: '', stderr: '' };
  }) as unknown as ExecFileMock;
}

export const SAMPLE_SSH_CONFIG = `
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

export const SAMPLE_SSH_CONFIG_WITH_INCLUDE = `
Include ~/.ssh/configs/*.conf

Host prod
    HostName 157.90.89.149
    User trashmail
`;

export const SAMPLE_KNOWN_HOSTS = `157.90.89.149 ssh-ed25519 AAAAC3Nz...
88.198.170.88 ssh-ed25519 AAAAC3Nz...
10.0.0.1 ssh-rsa AAAAB3Nz...
`;


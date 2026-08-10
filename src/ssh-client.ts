/**
 * All SSH operations. Uses the system's native `ssh`/`scp` binaries rather than
 * a JavaScript SSH library, so every option in the user's ~/.ssh/config applies.
 *
 * Security invariants (see CLAUDE.md → Threat Model):
 * - No shell, ever. spawn/execFile run with shell:false and an argv array, so
 *   nothing in a tool argument can reach a local shell.
 * - Every hostAlias passes _assertSafeHostAlias() (strict whitelist) and
 *   _assertKnownHostAlias() (must exist in the user's config or known_hosts).
 * - Every invocation carries `--` to terminate option parsing.
 */
import { spawn as nodeSpawn, execFile } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { unlinkSync } from 'node:fs';
import { writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SSHConfigParser } from './ssh-config-parser.js';
import { hostMatchesAlias } from './config-values.js';
import { debugLog, isWindows, SSH_BIN, SCP_BIN } from './platform.js';
import type {
  BatchResult,
  CommandResult,
  ConnectivityResult,
  HostInfo,
  SafeHostInfo,
  SpawnEnv,
} from './types.js';

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_SIZE = 10 * 1024 * 1024; // 10MB limit
const STRICT_HOST_KEY_CHECKING = ['-o', 'StrictHostKeyChecking=accept-new'];

type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
type ExecFileAsyncFn = (
  file: string,
  args: readonly string[],
  options: Record<string, unknown>,
) => Promise<{ stdout: string; stderr: string }>;

export class SSHClient {
  configParser: SSHConfigParser;
  /** Injection points for tests — production always uses the real ones. */
  _spawn: SpawnFn;
  _execFileAsync: ExecFileAsyncFn;
  private _askpassScript: string | null = null;

  constructor() {
    this.configParser = new SSHConfigParser();
    this._spawn = nodeSpawn as unknown as SpawnFn;
    this._execFileAsync = execFileAsync as unknown as ExecFileAsyncFn;
  }

  async listKnownHosts(): Promise<HostInfo[]> {
    return this.configParser.getAllKnownHosts();
  }

  /**
   * Strict whitelist. Two threats this defends against:
   *   1. ssh/scp option injection via leading '-' (e.g. -oProxyCommand=…),
   *      which would execute arbitrary commands LOCALLY on this machine.
   *   2. Shell-metacharacter injection, as defence in depth behind shell:false.
   * Allowed: alphanumerics, '.', '_', '-', ':', '@'. Must not start with '-'.
   *
   * Do not weaken this without understanding the implications — see the
   * CHANGELOG entry for 1.3.5.
   */
  _assertSafeHostAlias(hostAlias: unknown): asserts hostAlias is string {
    if (typeof hostAlias !== 'string' || hostAlias.length === 0) {
      throw new Error('hostAlias must be a non-empty string');
    }
    if (!/^[A-Za-z0-9_.@:][A-Za-z0-9._@:-]*$/.test(hostAlias)) {
      throw new Error(
        `Invalid hostAlias: must match [A-Za-z0-9._@:-] and not start with '-'`
      );
    }
  }

  /** The LLM may only reach hosts the user has actually configured. */
  async _assertKnownHostAlias(hostAlias: string): Promise<void> {
    const cleanAlias = stripUserPrefix(hostAlias);
    const knownHosts = await this.configParser.getAllKnownHosts();
    const isKnown = knownHosts.some(
      host => hostMatchesAlias(host, hostAlias) || hostMatchesAlias(host, cleanAlias)
    );
    if (!isKnown) {
      throw new Error(
        `Unknown hostAlias: ${hostAlias} is not defined in ~/.ssh/config or ~/.ssh/known_hosts`
      );
    }
  }

  async getPasswordForHost(hostAlias: string): Promise<string | null> {
    const cleanAlias = stripUserPrefix(hostAlias);
    const hosts = await this.configParser.processIncludeDirectives(this.configParser.configPath);
    const host = hosts.find(h => hostMatchesAlias(h, cleanAlias));
    return host?._password ?? null;
  }

  /**
   * Write the SSH_ASKPASS helper that echoes the password from the environment.
   * A batch file on Windows, a mode-700 shell script on POSIX.
   */
  async getAskpassScript(): Promise<string> {
    if (this._askpassScript) return this._askpassScript;

    let scriptPath: string;
    if (isWindows) {
      scriptPath = join(tmpdir(), `mcp-ssh-askpass-${process.pid}.cmd`);
      await writeFile(scriptPath, '@echo off\r\necho %MCP_SSH_PASS%\r\n');
    } else {
      scriptPath = join(tmpdir(), `mcp-ssh-askpass-${process.pid}.sh`);
      await writeFile(scriptPath, '#!/bin/sh\necho "$MCP_SSH_PASS"\n');
      await chmod(scriptPath, 0o700);
    }
    this._askpassScript = scriptPath;

    const cleanup = (): void => {
      try {
        unlinkSync(scriptPath);
      } catch {
        // Already gone, or never written — nothing to clean up.
      }
    };
    process.on('exit', cleanup);
    process.on('SIGINT', () => {
      cleanup();
      process.exit(130);
    });
    process.on('SIGTERM', () => {
      cleanup();
      process.exit(143);
    });

    return scriptPath;
  }

  /** Environment carrying the password, or null when the host uses key auth. */
  async buildSpawnEnv(hostAlias: string): Promise<SpawnEnv | null> {
    const password = await this.getPasswordForHost(hostAlias);
    if (!password) return null;

    // Refuse to use a password out of a world-readable config
    if (this.configParser._configsWithPasswords) {
      for (const configPath of this.configParser._configsWithPasswords) {
        await this.configParser.checkFilePermissions(configPath);
      }
    }

    const askpassScript = await this.getAskpassScript();
    return {
      ...process.env,
      MCP_SSH_PASS: password,
      SSH_ASKPASS: askpassScript,
      // `force` tells OpenSSH to use the askpass helper even without a GUI/TTY.
      // Avoid injecting a fake DISPLAY value here; that's a POSIX/X11 assumption
      // and can break platform-specific behavior, especially on Windows.
      SSH_ASKPASS_REQUIRE: 'force',
    };
  }

  async runRemoteCommand(
    hostAlias: string,
    command: string,
    options: { timeout?: number } = {},
  ): Promise<CommandResult> {
    this._assertSafeHostAlias(hostAlias);
    await this._assertKnownHostAlias(hostAlias);
    const timeout = options.timeout ?? 30000;

    debugLog(`Executing: ssh ${hostAlias} ${command}\n`);

    const passwordEnv = await this.buildSpawnEnv(hostAlias);

    return new Promise<CommandResult>((resolve) => {
      const spawnOptions: SpawnOptions = {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // shell:false is critical: with a shell the args would be re-parsed and
        // metacharacters in `command` could lead to local command injection. We
        // rely on resolveExecutable() to find ssh.exe on Windows, so PATH lookup
        // is not needed here.
        shell: false,
      };
      if (passwordEnv) {
        spawnOptions.env = passwordEnv;
        if (!isWindows) {
          // setsid needed on some systems so SSH uses SSH_ASKPASS instead of tty
          spawnOptions.detached = true;
        }
      }

      const child = this._spawn(
        SSH_BIN,
        [...STRICT_HOST_KEY_CHECKING, '--', hostAlias, command],
        spawnOptions,
      );

      let stdout = '';
      let stderr = '';
      let killed = false;
      let stdoutTruncated = false;
      let stderrTruncated = false;

      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGTERM');
      }, timeout);

      child.stdout?.on('data', (data: Buffer) => {
        if (stdout.length < MAX_OUTPUT_SIZE) {
          stdout += data.toString();
        } else if (!stdoutTruncated) {
          stdoutTruncated = true;
          stdout += '\n[Output truncated - exceeded 10MB limit]';
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        if (stderr.length < MAX_OUTPUT_SIZE) {
          stderr += data.toString();
        } else if (!stderrTruncated) {
          stderrTruncated = true;
          stderr += '\n[Stderr truncated - exceeded 10MB limit]';
        }
      });

      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        resolve({
          stdout,
          stderr: killed ? `${stderr}\n[Command timed out]` : stderr,
          code: killed ? 124 : (code ?? 0),
        });
      });

      child.on('error', (error: Error) => {
        clearTimeout(timer);
        debugLog(`Error executing command on ${hostAlias}: ${error.message}\n`);
        resolve({ stdout, stderr: error.message, code: 1 });
      });
    });
  }

  async getHostInfo(hostAlias: string): Promise<SafeHostInfo | null> {
    const hosts = await this.configParser.processIncludeDirectives(this.configParser.configPath);
    const host = hosts.find(h => hostMatchesAlias(h, hostAlias));
    if (!host) return null;

    // Never expose the password to the LLM
    const { _password, ...safeHost } = host;
    return _password ? { ...safeHost, passwordAuth: true } : safeHost;
  }

  async checkConnectivity(hostAlias: string): Promise<ConnectivityResult> {
    try {
      const result = await this.runRemoteCommand(hostAlias, 'echo connected');
      const connected = result.code === 0 && result.stdout.trim() === 'connected';

      return {
        connected,
        message: connected ? 'Connection successful' : 'Connection failed',
      };
    } catch (error) {
      const message = errorMessage(error);
      debugLog(`Connectivity error with ${hostAlias}: ${message}\n`);
      return { connected: false, message };
    }
  }

  async uploadFile(hostAlias: string, localPath: string, remotePath: string): Promise<boolean> {
    return this._scp(
      hostAlias,
      [localPath, `${hostAlias}:${remotePath}`],
      `Executing: scp ${localPath} ${hostAlias}:${remotePath}\n`,
      `Error uploading file to ${hostAlias}`,
    );
  }

  async downloadFile(hostAlias: string, remotePath: string, localPath: string): Promise<boolean> {
    return this._scp(
      hostAlias,
      [`${hostAlias}:${remotePath}`, localPath],
      `Executing: scp ${hostAlias}:${remotePath} ${localPath}\n`,
      `Error downloading file from ${hostAlias}`,
    );
  }

  /** Shared body of uploadFile/downloadFile — they differ only in argument order. */
  private async _scp(
    hostAlias: string,
    paths: [string, string],
    logLine: string,
    errorPrefix: string,
  ): Promise<boolean> {
    try {
      this._assertSafeHostAlias(hostAlias);
      await this._assertKnownHostAlias(hostAlias);
      debugLog(logLine);

      const passwordEnv = await this.buildSpawnEnv(hostAlias);
      const options: Record<string, unknown> = { timeout: 60000, windowsHide: true, shell: false };
      if (passwordEnv) options['env'] = passwordEnv;

      await this._execFileAsync(SCP_BIN, [...STRICT_HOST_KEY_CHECKING, '--', ...paths], options);
      return true;
    } catch (error) {
      debugLog(`${errorPrefix}: ${errorMessage(error)}\n`);
      return false;
    }
  }

  async runCommandBatch(hostAlias: string, commands: string[]): Promise<BatchResult> {
    try {
      const results: CommandResult[] = [];
      let success = true;

      for (const command of commands) {
        const result = await this.runRemoteCommand(hostAlias, command);
        results.push(result);

        // Keep going on failure — the caller sees every result
        if (result.code !== 0) success = false;
      }

      return { results, success };
    } catch (error) {
      const message = errorMessage(error);
      debugLog(`Error during batch execution on ${hostAlias}: ${message}\n`);
      return {
        results: [{ stdout: '', stderr: message, code: 1 }],
        success: false,
      };
    }
  }
}

/** "test@ssh-test" -> "ssh-test" */
function stripUserPrefix(hostAlias: string): string {
  const at = hostAlias.lastIndexOf('@');
  return at === -1 ? hostAlias : hostAlias.slice(at + 1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
import { realpathSync, readlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { writeFile, chmod } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep, dirname } from 'node:path';

import { SSHConfigParser } from './ssh-config-parser.js';
import { hostMatchesAlias } from './config-values.js';
import { debugLog, isWindows, isCaseSensitiveFs, SSH_BIN, SCP_BIN } from './platform.js';
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
const DEFAULT_TIMEOUT = 30000;
/** Upper bound when following a symlink chain, so a link loop cannot hang the check. */
const MAX_SYMLINK_HOPS = 16;
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
    this._spawn = nodeSpawn;
    this._execFileAsync = execFileAsync;
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

  /**
   * Reject a `localPath` that scp would treat as a *second remote endpoint*.
   *
   * scp decides "remote or local" by looking for a colon that is not preceded by
   * a path separator: `host:/path` and `scp://user@host:port//path` are remote,
   * `/tmp/a:b` is local. A `localPath` of `scp://attacker/…` therefore makes scp
   * open a second SSH connection and copy the file to a host that was never in
   * the user's config — bypassing _assertKnownHostAlias entirely, which is the
   * product's primary trust boundary. `--` does not help: it stops option
   * parsing, not remote-spec interpretation.
   *
   * Reported as GHSA-gpr2-2wqr-7rgp.
   */
  _assertLocalPath(localPath: unknown): asserts localPath is string {
    if (typeof localPath !== 'string' || localPath.length === 0) {
      throw new Error('localPath must be a non-empty string');
    }

    const colon = localPath.indexOf(':');
    if (colon === -1) return;

    // On Windows a leading drive letter is a local path, and scp there treats it
    // as one. Everywhere else `C:\…` really would be parsed as host `C`.
    if (isWindows && /^[A-Za-z]:[\\/]/.test(localPath)) return;

    // A separator before the colon makes it a path, exactly as scp decides it.
    // Backslash only counts as a separator on Windows.
    const separator = localPath.search(isWindows ? /[/\\]/ : /\//);
    if (separator !== -1 && separator < colon) return;

    throw new Error(
      'Invalid localPath: must be a local filesystem path, not an scp remote spec ' +
      '(a colon before the first path separator makes scp copy to another host)'
    );
  }

  /**
   * Reject a download destination inside the user's SSH directory.
   *
   * `~/.ssh/config` is the trust base of this whole product: it *is* the host
   * allowlist `_assertKnownHostAlias()` checks against, and ssh executes any
   * `ProxyCommand` it finds there **locally, through /bin/sh**. So a write into
   * that directory turns the by-design remote RCE of `runRemoteCommand` into
   * local RCE:
   *
   *   1. runRemoteCommand(anyConfiguredHost, 'cat > /tmp/x …ProxyCommand…')
   *   2. downloadFile(thatHost, '/tmp/x', '~/.ssh/config')
   *   3. runRemoteCommand('evil', 'true')   → ProxyCommand runs on this machine
   *
   * Step 3 is not theoretical — it was verified against the real ssh binary.
   * That contradicts the "local RCE must stay impossible" invariant, so the
   * write is refused even though path arguments are otherwise unsandboxed.
   *
   * This guards **integrity, not confidentiality**: `uploadFile` merely *reads*
   * localPath and is deliberately not covered. Blocking reads would be theatre
   * (every other secret on the disk stays readable by design) and would break
   * backing up one's own config to a configured host.
   */
  _assertNotSshDirectory(localPath: string): void {
    const sshDir = join(homedir(), '.ssh');
    // resolve() makes it absolute and collapses '..'; realpath resolves symlinks
    // on whatever part of the path already exists, so a link into ~/.ssh cannot
    // launder the destination.
    // Expand a leading '~' for the check only. We spawn without a shell, so scp
    // would take it literally — but a caller writing '~/.ssh/config' clearly
    // means the SSH directory, and treating it as a plain directory name would
    // let the guard be sidestepped by spelling.
    const expanded = /^~(?=$|[\\/])/.test(localPath)
      ? join(homedir(), localPath.slice(1))
      : localPath;
    const target = realpathish(resolve(expanded));
    const dir = realpathish(sshDir);

    // macOS and Windows are case-insensitive and realpath does not canonicalise
    // case there, so compare case-insensitively on those platforms.
    const norm = (p: string): string => (isCaseSensitiveFs ? p : p.toLowerCase());
    const t = norm(target);
    const d = norm(dir);

    if (t === d || t.startsWith(d + sep)) {
      throw new Error(
        `Invalid localPath: refusing to write inside ${sshDir}. That directory defines ` +
        `which hosts may be reached and can make ssh execute commands locally.`
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

    // A predictable path in a shared temp dir is a hijack target: ssh executes
    // this helper with MCP_SSH_PASS in its environment, so whoever controls the
    // file controls what runs and can capture the password. mkdtemp gives an
    // unpredictable, 0700 directory; `flag: 'wx'` makes the create exclusive so
    // an existing file or symlink is never followed.
    const dir = mkdtempSync(join(tmpdir(), 'mcp-ssh-'));
    let scriptPath: string;
    if (isWindows) {
      scriptPath = join(dir, `mcp-ssh-askpass-${process.pid}.cmd`);
      await writeFile(scriptPath, '@echo off\r\necho %MCP_SSH_PASS%\r\n', { flag: 'wx' });
    } else {
      scriptPath = join(dir, `mcp-ssh-askpass-${process.pid}.sh`);
      await writeFile(scriptPath, '#!/bin/sh\necho "$MCP_SSH_PASS"\n', { flag: 'wx', mode: 0o700 });
      await chmod(scriptPath, 0o700);
    }
    this._askpassScript = scriptPath;

    const cleanup = (): void => {
      try {
        rmSync(dir, { recursive: true, force: true });
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
    // `||`, not `??`: a zero timeout means "not specified" here, as it does in
    // the tool dispatcher. With `??` a caller passing 0 would get an immediate
    // SIGTERM instead of the default.
    const timeout = options.timeout || DEFAULT_TIMEOUT;

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
      localPath,
      [localPath, `${scpHost(hostAlias)}:${remotePath}`],
      `Executing: scp ${localPath} ${hostAlias}:${remotePath}\n`,
      `Error uploading file to ${hostAlias}`,
    );
  }

  async downloadFile(hostAlias: string, remotePath: string, localPath: string): Promise<boolean> {
    return this._scp(
      hostAlias,
      localPath,
      [`${scpHost(hostAlias)}:${remotePath}`, localPath],
      `Executing: scp ${hostAlias}:${remotePath} ${localPath}\n`,
      `Error downloading file from ${hostAlias}`,
      // localPath is the destination here: guard the SSH directory against writes.
      true,
    );
  }

  /** Shared body of uploadFile/downloadFile — they differ only in argument order. */
  private async _scp(
    hostAlias: string,
    localPath: string,
    paths: [string, string],
    logLine: string,
    errorPrefix: string,
    localPathIsDestination = false,
  ): Promise<boolean> {
    try {
      this._assertSafeHostAlias(hostAlias);
      // Validate before the known-host lookup: a remote spec in localPath must
      // be rejected outright, not merely because the alias happens to be unknown.
      this._assertLocalPath(localPath);
      if (localPathIsDestination) this._assertNotSshDirectory(localPath);
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

/**
 * Resolve a path as far as it exists, so a symlink cannot hide the real target.
 * The final component of a download destination usually does not exist yet, so
 * walk up to the nearest existing ancestor and resolve that.
 */
function realpathish(p: string): string {
  let abs = resolve(p);

  // realpath refuses a symlink whose target does not exist yet, which is exactly
  // the shape that matters here: a link planted at ~/.ssh/<not-yet-created>.
  // Follow the chain by hand first. The hop cap breaks symlink loops.
  for (let hops = 0; hops < MAX_SYMLINK_HOPS; hops++) {
    let target: string;
    try {
      target = readlinkSync(abs);
    } catch {
      break;   // not a symlink (or unreadable) — nothing more to follow
    }
    abs = resolve(dirname(abs), target);
  }

  const segments = abs.split(sep);
  // Longest prefix first. i stops at 2 because the one-segment prefix is the
  // filesystem root, which always resolves and would make the loop pointless.
  for (let i = segments.length; i > 1; i--) {
    try {
      return join(realpathSync(segments.slice(0, i).join(sep)), ...segments.slice(i));
    } catch {
      // This prefix does not exist yet — try a shorter one.
    }
  }
  return abs;   // not even the top-level entry exists
}

/**
 * Render the host part of an scp remote spec.
 *
 * scp splits `host:path` on the FIRST colon, while ssh never splits its
 * destination argument. So an alias the allowlist approved — `a:b`, or a bare
 * IPv6 address — would send scp to a *different* host than the one that was
 * validated. Verified against the real binary: `2001:db8::1:/p` connects to
 * 0.0.7.209, and `a:b:/p` connects to `a`.
 *
 * Brackets pin the host explicitly. They are valid for ordinary names too, so
 * this needs no special case — but `user@` belongs OUTSIDE the bracket:
 * scp reads `[user@host]:/p` as host `host]`.
 */
function scpHost(hostAlias: string): string {
  const at = hostAlias.lastIndexOf('@');
  return at === -1
    ? `[${hostAlias}]`
    : `${hostAlias.slice(0, at + 1)}[${hostAlias.slice(at + 1)}]`;
}

/** "test@ssh-test" -> "ssh-test" */
function stripUserPrefix(hostAlias: string): string {
  const at = hostAlias.lastIndexOf('@');
  return at === -1 ? hostAlias : hostAlias.slice(at + 1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

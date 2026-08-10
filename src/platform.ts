/**
 * Platform detection and process-level setup that has to happen before anything
 * spawns ssh or scp.
 *
 * Everything here runs once, at module load. Tests exercise both the POSIX and
 * the Windows path by re-importing this module with `process.platform` faked —
 * see loadServerAs() in the test suite.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';

export const isWindows = process.platform === 'win32';

/**
 * macOS and Windows compare filenames case-insensitively, and realpath does not
 * canonicalise case there — so a path comparison that must not be bypassable by
 * spelling has to fold case on those platforms.
 */
export const isCaseSensitiveFs = process.platform === 'linux';

/**
 * Windows + restricted MCP hosts: Claude Desktop launches the extension with a
 * stripped, allow-listed environment that omits %ProgramData% and
 * %ALLUSERSPROFILE%. Win32-OpenSSH resolves %ProgramData% at startup to find its
 * global config (%ProgramData%\ssh\) and exits 255 with no output at all when it
 * is unset, so every spawned ssh/scp fails while the same command works from a
 * normal shell. Normalizing here means every child inherits usable values,
 * whether or not the caller passes an explicit env. See issue #10.
 */
if (isWindows) {
  if (!process.env['ProgramData']) {
    // Derive the last-resort default from %SystemDrive% rather than hardcoding
    // C:, so a Windows install on another drive still gets a valid path.
    // SystemDrive is part of the environment Claude Desktop does pass through.
    const systemDrive = (process.env['SystemDrive'] || 'C:').replace(/[\\/]+$/, '');
    process.env['ProgramData'] = process.env['ALLUSERSPROFILE'] || `${systemDrive}\\ProgramData`;
  }
  if (!process.env['ALLUSERSPROFILE']) {
    process.env['ALLUSERSPROFILE'] = process.env['ProgramData'];
  }
}

/**
 * Resolve an executable's absolute path on Windows by walking PATH and PATHEXT.
 *
 * This lets us call spawn() with shell:false on Windows — without it we would
 * need shell:true to find ssh.exe/scp.exe via PATH, which would route every
 * argument through cmd.exe and make characters like &, |, ^, >, " usable for
 * local command injection. Returns the bare name on non-Windows (POSIX spawn
 * already searches PATH safely).
 */
export function resolveExecutable(name: string): string {
  if (!isWindows) return name;
  // No `|| process.env.Path` fallback: Node exposes process.env case-insensitively
  // on Windows, so process.env.PATH already resolves a variable spelled `Path`.
  const pathDirs = (process.env['PATH'] || '').split(';');
  const exts = (process.env['PATHEXT'] || '.EXE;.CMD;.BAT;.COM').split(';');
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Not on this PATH entry — keep looking.
      }
    }
  }
  return `${name}.exe`;
}

export const SSH_BIN = resolveExecutable('ssh');
export const SCP_BIN = resolveExecutable('scp');

/**
 * Silent mode for MCP clients: debug output on stdout would corrupt the STDIO
 * JSON-RPC stream, so it goes to stderr and can be switched off entirely.
 */
export const SILENT_MODE =
  process.env['MCP_SILENT'] === 'true' || process.argv.includes('--silent');

export function debugLog(message: string): void {
  if (!SILENT_MODE) {
    process.stderr.write(message);
  }
}

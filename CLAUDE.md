# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is MCP SSH Agent (@aiondadotcom/mcp-ssh) - a Model Context Protocol (MCP) server that provides SSH operations for AI assistants like Claude Desktop. The project uses native SSH commands (`ssh`, `scp`) rather than JavaScript SSH libraries for maximum reliability and compatibility.

## Development Commands

### Basic Operations
- `npm start` - Start the MCP server (same as `npm run dev`)
- `npm run dev` - Start the MCP server with debug output
- `npm run build` - Currently a no-op (echo "Build skipped")
- `npm test` - Run the vitest suite (`server.test.mjs`) with coverage
- `npm run test:watch` - Vitest in watch mode

### Development Scripts
- `./start.sh` - Start the server with debug output
- `./start-silent.sh` - Start the server in silent mode (no debug output)
- `node bin/mcp-ssh.js` - Direct server execution. **Not** `node server.mjs`: since 1.3.6 that file no longer auto-runs `main()`, so running it directly exits immediately (this caused the 1.3.8 regression)

### Publishing
- `npm version patch|minor|major` - Bump version and create git tag
- `npm publish` - Publish to npm (see PUBLISHING.md for details)
- `npm pack` - Create tarball for testing

### DXT Package Building
- `npm run build:dxt` - Build Desktop Extension (.dxt) package
- `./scripts/build-dxt.sh` - Direct build script execution

## Architecture

### Main Entry Point
- `server.mjs` - Self-contained MCP server implementation that includes all functionality inline to avoid module resolution issues

### Other Files
- `bin/mcp-ssh.js` - Binary wrapper for npx compatibility; the real entry point (imports and calls `main()`)
- `server.test.mjs` - Test suite
- `vitest.config.mjs` - Test and coverage configuration, including the 100% coverage thresholds
- `.gitattributes` - Forces LF checkout on every platform (see Testing)

### Key Design Decisions
1. **Native SSH Tools**: Uses system `ssh` and `scp` commands rather than JavaScript SSH libraries for reliability
2. **Self-contained**: `server.mjs` includes all code inline to avoid ESM import issues
3. **Silent Mode**: Controlled by `MCP_SILENT` environment variable to disable debug output when used as MCP server
4. **No shell on spawn**: All `spawn`/`execFile` calls use `shell: false`. On Windows, `ssh.exe`/`scp.exe` are resolved to absolute paths once at startup via `resolveExecutable()` (PATH + PATHEXT walk), so PATH lookup does not require `shell: true`. This is required to prevent local command injection through shell metacharacters in tool arguments.
5. **Strict `hostAlias` whitelist**: `_assertSafeHostAlias()` (`SSHClient`) rejects any `hostAlias` that does not match `^[A-Za-z0-9_.@:][A-Za-z0-9._@:-]*$`. Combined with the `--` argument terminator on every `ssh`/`scp` invocation, this blocks SSH option injection (e.g. `-oProxyCommand=…`) and shell-metacharacter injection. Validation is applied at the public entry points (`runRemoteCommand`, `uploadFile`, `downloadFile`) and transitively covers `checkConnectivity` and `runCommandBatch`. **Do not weaken or bypass this validator** without understanding the security implications — see CHANGELOG entry for 1.3.5.

## SSH Configuration Integration

The agent automatically discovers SSH hosts from:
- `~/.ssh/config` - Primary source for host configurations
- `~/.ssh/known_hosts` - Additional hosts not in config

Host discovery prioritizes SSH config entries first, then adds additional hosts from known_hosts.

### ssh-config value normalization

`ssh-config@5` returns a **plain string** for a single-token value but an **array of token
objects** (`{val, separator, quoted}`) as soon as a multi-value directive carries more than one
token — affecting `Host`, `Match`, `ProxyCommand`, `SendEnv`, `IPQoS`, `CanonicalDomains`,
`GlobalKnownHostsFile`, `UserKnownHostsFile`. Everything must go through `configValueTokens()` /
`configValueToString()`, which normalize both shapes at parse time. Comparing a raw
`section.value` against a string silently fails for multi-token blocks; that was the cause of
issue #12, where `Host docker-lxc hlab` was unreachable under *either* alias.

Consequences to preserve:
- `alias` holds the **first** alias (output shape for single-alias hosts is unchanged); `aliases`
  holds the full list. Match through `hostMatchesAlias()`, never with a bare `===` on `alias`.
- Blocks whose patterns are all wildcards or negations (`Host *`, `Host * !bastion`) are defaults
  blocks, not connectable hosts, and are skipped.
- Hosts without a `Hostname` are skipped.

### Windows environment normalization

Windows-only, at module load: `%ProgramData%` and `%ALLUSERSPROFILE%` are backfilled (default
derived from `%SystemDrive%`). MCP hosts such as Claude Desktop launch the server with a
stripped, allow-listed environment omitting them, and Win32-OpenSSH exits 255 with **no output**
when `%ProgramData%` is unset — so every spawned `ssh`/`scp` fails while the same command works
in a shell. See issue #10. This mutates `process.env` at import time, which the test helper has
to save and restore (see below).

### Password Authentication

Passwords can be stored as comment annotations in `~/.ssh/config`:
```
Host myrouter
    HostName 192.168.1.1
    User admin
    # @password:secretPassword
```

- The `# @password:` annotation is read locally — the password **never** reaches the LLM or cloud provider
- Works for login passwords and SSH key passphrases
- Passwords are stripped from all tool outputs (only `passwordAuth: true` is exposed)
- The server enforces `chmod 600` on config files containing `@password` annotations
- Uses `SSH_ASKPASS` mechanism internally (temp script + env variable, no external dependencies)
- The `user@host` format is supported for password lookup (strips user prefix to find the config entry)
- Unknown host fingerprints are auto-accepted via `StrictHostKeyChecking=accept-new` (changed keys are still rejected)

## MCP Tools Provided

1. **listKnownHosts()** - Lists all discovered SSH hosts
2. **runRemoteCommand(hostAlias, command)** - Execute commands via SSH
3. **getHostInfo(hostAlias)** - Get host configuration details
4. **checkConnectivity(hostAlias)** - Test SSH connectivity
5. **uploadFile(hostAlias, localPath, remotePath)** - Upload files via SCP
6. **downloadFile(hostAlias, remotePath, localPath)** - Download files via SCP
7. **runCommandBatch(hostAlias, commands)** - Execute multiple commands sequentially

## Testing and Debugging

### Test Suite Invariants

`vitest.config.mjs` pins **100% of statements, branches, functions and lines** of `server.mjs`
and fails the build below that. `bin/mcp-ssh.js` is excluded (top-level await that starts a real
server). When adding code, add the test with it; when a branch turns out to be unreachable,
prefer deleting it over working around the threshold — that is how the dead
`process.env.Path` fallback in `resolveExecutable()` was removed.

**Platform-specific code is tested from either OS, never skipped.** `loadServerAs(platform, env)`
in `server.test.mjs` re-imports `server.mjs` with `process.platform` (and optionally parts of the
environment) faked, so the Windows branches are covered when running on macOS/Linux and vice
versa. Things it has to handle, and that new tests must respect:
- `vi.resetModules()` re-runs the `vi.mock('fs/promises')` factory, so the returned `fs` spies are
  **new objects** — the statically imported `readFile`/`stat`/… are a different module instance.
- `server.mjs` writes `ProgramData`/`ALLUSERSPROFILE` to `process.env` at import time. The helper
  always saves and restores them (`ENV_MUTATED_AT_IMPORT`) and exposes `envAfterImport`, because
  the restore happens before a test can assert. Without this, one Windows import leaks state into
  later tests and makes those branches *look* covered while nothing asserts them.
- Assert argv[0] against the exported `SSH_BIN`/`SCP_BIN`, not a literal `'ssh'` — on Windows they
  are absolute paths.
- The `MCP Server Handlers` block drives the real `SSHClient` from `main()`; its
  process-starting methods are stubbed so tests never spawn actual `ssh`/`scp`.

**CI** runs Linux and Windows across Node 20/22/24. `.gitattributes` forces an LF checkout on all
platforms: with CRLF, Vite's SSR transform cannot parse the `#!/usr/bin/env node` shebang in
`server.mjs` and the entire suite dies with a `SyntaxError` before any test runs. Do not remove it.

### Manual Testing
```bash
# Test as MCP server
npx @aiondadotcom/mcp-ssh

# Test with debug output
MCP_SILENT=false npx @aiondadotcom/mcp-ssh

# Test installation
npm pack
npm install -g ./aiondadotcom-mcp-ssh-*.tgz
mcp-ssh
```

### Integration Testing
Configure in Claude Desktop's `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "mcp-ssh": {
      "command": "npx",
      "args": ["@aiondadotcom/mcp-ssh"]
    }
  }
}
```

## Dependencies

- `@modelcontextprotocol/sdk` - MCP protocol implementation
- `ssh-config` - SSH configuration file parsing
- Node.js built-ins: `child_process`, `fs/promises`, `os`, `path`

## Desktop Extension Support

The project supports Desktop Extensions (.dxt) for easy installation in Claude Desktop:

- `manifest.json` - DXT package manifest with server configuration
- `scripts/build-dxt.sh` - Build script that creates .dxt packages in `build/` directory
- `.dxt` files are ZIP archives containing the manifest and server files
- Built packages are excluded from git via `.gitignore` but can be uploaded to GitHub releases

## Threat Model

The LLM driving this MCP server is **not trusted** — its tool arguments can be steered by prompt injection from any untrusted text in the conversation context (web pages, e-mails, repo files, output of other MCP servers). When changing this codebase, keep these invariants:

- **Local RCE must stay impossible.** `hostAlias`, `command`, `localPath` and `remotePath` must never reach a shell on the local machine. Use `spawn`/`execFile` with `shell: false` and an argv array. Never re-introduce `shell: true`.
- **`runRemoteCommand` is by-design RCE on the configured remote.** That is the tool's contract; do not try to "sanitize" the `command` argument.
- **`uploadFile`/`downloadFile` give the LLM the local filesystem with the server process's privileges.** The README documents this; users are expected to run mcp-ssh under an unprivileged user or in a sandbox. Path arguments are not sandboxed.
- **`# @password:` values must never appear in MCP responses** or in any string the LLM can see. Only `passwordAuth: true` is exposed.
- See README → "Threat Model and Trust Boundaries" for the user-facing version of this.

## Important Notes

- The project is ESM-only (`"type": "module"` in package.json). The `.mjs` extension on `server.mjs` is historical and redundant given `"type": "module"`; keep it for now to avoid touching `bin/`, `manifest.json`, `package.json` `main`, and the start scripts.
- Production code is in `server.mjs`, not compiled from TypeScript
- SSH operations require properly configured SSH keys or `@password` annotations
- The agent runs over STDIO as an MCP server, not as a standalone application
- DXT packages provide one-click installation alternative to manual JSON configuration
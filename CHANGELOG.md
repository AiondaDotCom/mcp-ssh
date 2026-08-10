# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **Ported to TypeScript.** The single self-contained `server.mjs` is now seven typed modules under `src/`, compiled to `dist/` by `tsc`: `server.ts` (MCP wiring and `main()`), `tools.ts` (tool schemas and dispatch), `ssh-client.ts`, `ssh-config-parser.ts`, `config-values.ts`, `platform.ts` (everything with module-load side effects) and `types.ts`. `bin/mcp-ssh.js` and the DXT package load `dist/server.js`; `dist/` is generated, not tracked in git, and built by the `prepare` script on install.
  - `tsconfig.json` runs `strict` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature` and `verbatimModuleSyntax`. Test files are checked under a lighter config (`tsconfig.test.json`).
  - Added ESLint with `typescript-eslint` type-aware rules (`strictTypeChecked` + `stylisticTypeChecked`). Relaxations are documented in place; notably `prefer-nullish-coalescing` exempts strings and numbers, because `??` is *not* equivalent to `||` for a stripped launcher environment (an empty `%ProgramData%` must fall through, see #10) or for `timeout || DEFAULT`.
  - Removed dead devDependencies `ts-node` and `@types/ssh2` — the repo had no `.ts` files and never used `ssh2`.
  - The test suite is split along the same module boundaries (four files plus shared `test-helpers.ts`) and grew from 148 to 152 tests, still at 100% coverage of statements, branches, functions and lines.
  - CI now runs `typecheck`, `lint`, the suite, and a smoke test that starts the *compiled* server over STDIO — the delivery chain that broke in 1.3.6 and 1.3.8 is now verified on every push, on Linux and Windows across Node 20/22/24.
  - No behavioural changes: every existing test passes unmodified except where a mock had to follow the module split.

### Security
- Resolved all 17 open `npm audit` advisories (12 high, 4 moderate, 1 low) that accumulated since the 1.3.7 cleanup. `npm audit` now reports zero vulnerabilities again. `npm audit fix` could not be used — it aborts with an internal npm error (`Cannot read properties of null (reading 'edgesOut')`) on this tree's `overrides` — so the fixes are pinned explicitly:
  - Direct bumps, all within the existing semver range: `@modelcontextprotocol/sdk` 1.27.1 → 1.30.0, `vitest`/`@vitest/coverage-v8` 4.1.4 → 4.1.10, `@anthropic-ai/dxt` 0.2.5 → 0.2.6. These cleared the `vite`, `postcss` and `nanoid` advisories.
  - Raised the existing `tmp` override from `>=0.2.4` to `>=0.2.6` (GHSA path traversal via unsanitized prefix/postfix), which cleared the whole `@anthropic-ai/dxt → @inquirer/prompts → @inquirer/editor → external-editor → tmp` chain.
  - New overrides for the transitive HTTP-stack advisories reachable through `@modelcontextprotocol/sdk`: `brace-expansion`, `fast-uri`, `ip-address`, `hono`, `@hono/node-server`, `body-parser`, `qs`, `express-rate-limit`. Each is pinned to the lowest version that carries the fix. As in 1.3.7, none of this code is reachable from this package: it belongs to the SDK's HTTP/SSE transport, and mcp-ssh only ever loads `server/stdio.js`.
- Verified after the bumps: full suite green, `npm ci` reproducible from the lockfile, and the real server answers `initialize` and `tools/list` correctly over STDIO.

### Fixed
- **Windows/Claude Desktop: every SSH command failed with exit 255 (fixes #10)**: Claude Desktop launches the extension with a stripped, allow-listed environment that omits `%ProgramData%` and `%ALLUSERSPROFILE%`. Win32-OpenSSH resolves `%ProgramData%` at startup to locate its global config (`%ProgramData%\ssh\`) and exits 255 **before producing any output** when it is unset — so every spawned `ssh`/`scp` failed with empty stdout/stderr while the identical command succeeded from a normal shell. Both spawn paths were affected: key-auth hosts get no env override and inherit `process.env` implicitly, and password hosts spread a `process.env` that is itself missing the variable. Both variables are now normalized once at module load, Windows only. Reported by @Krolikfarm with an environment bisection, independently reproduced by @pa-bmundt, and contributed by @pa-bmundt.
  - The fallback derives from `%SystemDrive%` instead of hardcoding `C:`, so a Windows install on another drive still gets a valid path (`SystemDrive` is one of the variables Claude Desktop does pass through), and tolerates a trailing separator.
- **Multi-alias hosts (fixes #12)**: A host declared under several aliases (`Host docker-lxc hlab`) was unreachable under *any* of its names. `ssh-config@5` returns a plain string for a single-token value but an array of token objects (`{val, separator, quoted}`) once a directive carries more than one token; `extractHostsFromConfig` stored that array in `alias` verbatim, so every strict comparison downstream (`_assertKnownHostAlias`, `getHostInfo`, `getPasswordForHost`, `getAllKnownHosts`) compared a string against an array and never matched. The host was listed by `listKnownHosts` but rejected by the known-host gate before `ssh` was ever spawned. ssh-config values are now normalized once at parse time: `alias` keeps the first alias (output shape unchanged), a new `aliases` field carries the full list, and matching goes through a shared `hostMatchesAlias()` helper. Contributed by @badigit.
- **Wildcard blocks with negations**: `Host * !bastion` was emitted as a connectable host if it carried a `HostName`. The old `section.value !== '*'` check could not match a multi-token value, which is an array. Blocks consisting only of wildcards and negated patterns are now skipped as the defaults blocks they are.
- **Multi-token directives**: `ProxyCommand`, `SendEnv`, `IPQoS` and friends were surfaced in `listKnownHosts` output as arrays of token objects instead of readable strings. They are now flattened.

### Changed
- **Windows test suite**: 14 tests silently asserted POSIX-only behaviour (the `chmod 600` config check, the `/bin/sh` askpass helper, `detached`, a bare `ssh` as argv[0]) and failed when the suite ran on Windows. Both platform paths are now asserted explicitly by re-importing the module with `process.platform` faked, so the suite is meaningful and green on either OS. `SSH_BIN`/`SCP_BIN` are exported so tests assert against the binary the module actually resolved.
- **CI**: the test matrix now runs on `windows-latest` in addition to `ubuntu-latest`, across Node 20/22/24.
- **Coverage**: `server.mjs` is at 100% statements, branches, functions and lines, and `vitest.config.mjs` pins those thresholds so a change adding an untested line or branch fails the build.
- Dropped the `process.env.Path` fallback in `resolveExecutable()`: Node exposes `process.env` case-insensitively on Windows, so `process.env.PATH` already resolves a variable spelled `Path`. The fallback was unreachable.

## [1.3.8] - 2026-04-14

### Fixed
- **Startup regression**: The `start.sh`, `start-silent.sh`, `npm start`, `npm run dev`, and DXT manifest all launched `node server.mjs` directly, but since 1.3.6 `server.mjs` no longer auto-runs `main()` — only `bin/mcp-ssh.js` does. The server therefore exited immediately on startup for anyone not invoking the bin wrapper (including the shipped start scripts and DXT package). All entry points now call `node bin/mcp-ssh.js`.

## [1.3.7] - 2026-04-11

### Security
- Resolved all open `npm audit` advisories (4 high, 3 moderate) by bumping transitive dependencies. Seven GHSAs no longer reachable from this package:
  - `path-to-regexp` (prod, via `@modelcontextprotocol/sdk → express → router`) — CVE-2024-45296 / CVE-2024-52798 DoS (not exploitable via our STDIO-only usage, fixed anyway).
  - `node-forge` — GHSA-2328-f5f3-gj25, GHSA-q67f-28xg-22rw, GHSA-5m6q-g25r-mvwx, GHSA-ppp5-5v6c-4jwp.
  - `hono`, `@hono/node-server`, `brace-expansion` (dev, via vitest chain).
  - `picomatch`, `vite` (dev, via vitest chain) — required a `vitest`/`@vitest/coverage-v8` minor bump from 4.0.18 to 4.1.4.
- `npm audit --audit-level=high` now reports zero vulnerabilities. CI workflow's security audit step is unchanged and continues to block on any future high-severity finding.

## [1.3.6] - 2026-04-11

### Fixed
- **Windows startup (fixes #8)**: The server silently exited when launched via `bin/mcp-ssh.js` on Windows MCP clients (e.g. Antigravity), causing a "failed to initialize: EOF" error. The cause was an `isMainModule` check in `server.mjs` that compared `process.argv[1]` against forward-slash path suffixes (`/mcp-ssh.js`), which never matched on Windows where `process.argv[1]` uses backslashes. The check has been removed entirely; `bin/mcp-ssh.js` now imports `main()` from `server.mjs` and calls it explicitly. Reported by @sdwru.

## [1.3.5] - 2026-04-11

### Security
- **SECURITY FIX (high)**: Fixed SSH `ProxyCommand` option-injection that allowed local RCE on the machine running the MCP server. A crafted `hostAlias` such as `-oProxyCommand=...` was passed to `ssh`/`scp` without an argument-terminator, so SSH interpreted it as an option and executed the attacker's command locally — bypassing the documented protection of `# @password:` annotations and exposing local SSH keys and credentials.
- **SECURITY FIX (high, Windows-only)**: Fixed a second local-RCE vector on Windows. `runRemoteCommand`, `uploadFile` and `downloadFile` previously used `spawn(..., { shell: true })` so that `ssh.exe`/`scp.exe` could be found via PATH. With `shell: true` every argument is re-parsed by `cmd.exe`, so shell metacharacters (`&`, `|`, `^`, `>`, `"`, `;`, etc.) in `hostAlias`, `command`, `localPath` or `remotePath` would have been interpreted by `cmd.exe` and could trigger arbitrary local command execution. The server now resolves `ssh.exe`/`scp.exe` to absolute paths once at startup (via PATH + PATHEXT walk) and uses `shell: false` everywhere.
- **Hardening**: Added a strict whitelist for `hostAlias` (`^[A-Za-z0-9_.@:][A-Za-z0-9._@:-]*$`). Rejects leading `-` (option injection) and all shell metacharacters (cmd.exe injection). Applied to `runRemoteCommand`, `uploadFile`, `downloadFile` (and transitively to `checkConnectivity` and `runCommandBatch`).
- **Hardening**: Added a known-host check (`_assertKnownHostAlias`) that requires every `hostAlias` to be defined in `~/.ssh/config` (including Include directives) or present in `~/.ssh/known_hosts`. The LLM can no longer reach arbitrary hostnames the user has not explicitly configured — Whitelist instead of Blacklist.
- **Hardening**: Added `--` argument terminator to all `ssh`/`scp` invocations as defense in depth.
- **Fix**: Removed the hard-coded `DISPLAY=:0` value from the SSH askpass environment. It was a POSIX/X11 assumption that could break behavior on Windows; `SSH_ASKPASS_REQUIRE=force` is sufficient on its own.
- **Fix**: `expandIncludePath()` now handles Windows drive-letter and UNC paths correctly (`path.isAbsolute` + `path.win32.isAbsolute`) and accepts `~\path` with a backslash separator.
- Added regression tests for the option-injection vector and shell-metacharacter vector across all five affected tools.
- Documented the tool's threat model and trust boundaries in `README.md` (`runRemoteCommand` is by-design remote RCE; `uploadFile`/`downloadFile` expose the local filesystem with the server process's privileges; recommend running under an unprivileged user or in a container).
- Reported by Pico (`piiiico` on GitHub) as part of an MCP server security audit. Thank you for the responsible disclosure.

## [1.1.0] - 2025-08-17

### Added
- **NEW FEATURE**: SSH config Include directive support
- Added recursive processing of Include directives in SSH configuration files
- Support for glob patterns in Include paths (e.g., `Include ~/.ssh/configs/*`)
- Enhanced SSH host discovery from included configuration files
- Added `glob` dependency for Include path pattern matching

### Enhanced
- Improved SSH configuration parsing to handle complex Include hierarchies
- Enhanced host discovery to recursively process all included config files
- Better error handling for malformed or inaccessible Include files

## [1.0.4] - 2025-08-17

### Security
- **SECURITY FIX**: Fixed command injection vulnerability in SSH operations (commit 5b9b9c5)
- **SECURITY FIX**: Upgraded `tmp` dependency to version 0.2.5 to address CVE vulnerability
- Fixed arbitrary temporary file/directory write via symbolic link in `tmp` package (GHSA-52f5-9888-hmc6)
- Added dependency overrides to ensure all transitive dependencies use secure `tmp` version
- Enhanced input validation and sanitization for SSH commands and file paths

### Technical
- Added `tmp: ">=0.2.4"` to devDependencies to force secure version
- Added npm overrides configuration to enforce secure tmp version across entire dependency tree
- Updated package-lock.json to reflect security fixes

## [1.0.3] - 2025-06-06

### Added
- Binary wrapper script (`bin/mcp-ssh.js`) for proper npx compatibility
- Fixed npx execution issues by implementing wrapper pattern

### Fixed
- NPX executable resolution using wrapper script approach
- Package binary configuration now points to proper wrapper

### Technical
- Added `bin/mcp-ssh.js` wrapper to handle npx execution
- Updated package.json bin configuration to use wrapper script

## [1.0.2] - 2025-06-06

### Fixed
- Build script temporary fix
- File permissions for executable

## [1.0.1] - 2025-06-06

### Fixed
- Initial package configuration
- File permissions

## [1.0.0] - 2025-06-06

### Added
- Initial release of MCP SSH Agent
- Support for all SSH operations via native ssh/scp commands
- Automatic SSH host discovery from ~/.ssh/config and ~/.ssh/known_hosts
- Functions: listKnownHosts, runRemoteCommand, getHostInfo, checkConnectivity, uploadFile, downloadFile, runCommandBatch
- Claude Desktop integration support
- NPM package distribution via @aiondadotcom/mcp-ssh
- npx compatibility for easy installation and usage

### Features
- Native SSH command execution for maximum compatibility
- Silent mode for MCP clients (MCP_SILENT=true)
- Comprehensive error handling with timeouts
- Batch command execution support
- File upload/download via scp
- SSH connectivity testing

### Documentation
- Complete README with Claude Desktop setup instructions
- Usage examples and troubleshooting guide
- Professional npm package configuration

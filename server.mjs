#!/usr/bin/env node

/**
 * MCP SSH Agent - A Model Context Protocol server for managing SSH connections
 * 
 * This is a simplified implementation that directly imports from specific files
 * to avoid module resolution issues.
 */

// Import required Node.js modules
import { homedir } from 'os';
import { readFile, stat, writeFile, chmod, unlink } from 'fs/promises';
import { join } from 'path';
import { createRequire } from 'module';

// Use createRequire to work around ESM import issues
const require = createRequire(import.meta.url);

// Required libraries
const { spawn, exec, execFile } = require('child_process');
const { promisify } = require('util');
const { statSync } = require('fs');
const sshConfig = require('ssh-config');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const isWindows = process.platform === 'win32';

// Windows + Claude Desktop: extensions are launched with a stripped, allow-listed
// environment that omits %ProgramData% and %ALLUSERSPROFILE%. Win32-OpenSSH needs
// %ProgramData% to locate its global config (%ProgramData%\ssh\) at startup and
// exits 255 with no output before it produces anything when the variable is unset,
// which makes every spawned ssh/scp fail. Normalize the vars once at module load so
// every spawned child inherits them. See issue #10.
if (isWindows) {
  if (!process.env.ProgramData) {
    process.env.ProgramData = process.env.ALLUSERSPROFILE || 'C:\\ProgramData';
  }
  if (!process.env.ALLUSERSPROFILE) {
    process.env.ALLUSERSPROFILE = process.env.ProgramData;
  }
}

// Resolve an executable's absolute path on Windows by walking PATH and PATHEXT.
// This lets us call spawn() with shell:false on Windows — without it we would
// need shell:true to find ssh.exe/scp.exe via PATH, which would route every
// argument through cmd.exe and make characters like &, |, ^, >, " usable for
// local command injection. Returns the bare name on non-Windows (POSIX spawn
// already searches PATH safely).
function resolveExecutable(name) {
  if (!isWindows) return name;
  const pathDirs = (process.env.PATH || process.env.Path || '').split(';');
  const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';');
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return name + '.exe';
}

const SSH_BIN = resolveExecutable('ssh');
const SCP_BIN = resolveExecutable('scp');

// Silent mode for MCP clients - disable debug output when used as MCP server
const SILENT_MODE = process.env.MCP_SILENT === 'true' || process.argv.includes('--silent');

// Debug logging function - only outputs in non-silent mode
function debugLog(message) {
  if (!SILENT_MODE) {
    process.stderr.write(message);
  }
}

// Import MCP components using proper export paths
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

// SSH Configuration Parser
class SSHConfigParser {
  constructor() {
    const homeDir = homedir();
    this.configPath = join(homeDir, '.ssh', 'config');
    this.knownHostsPath = join(homeDir, '.ssh', 'known_hosts');
  }

  async parseConfig() {
    try {
      const content = await readFile(this.configPath, 'utf-8');
      const config = sshConfig.parse(content);
      return this.extractHostsFromConfig(config, this.configPath);
    } catch (error) {
      debugLog(`Error reading SSH config: ${error.message}\n`);
      return [];
    }
  }

  async processIncludeDirectives(configPath) {
    try {
      const content = await readFile(configPath, 'utf-8');
      const config = sshConfig.parse(content);
      const hosts = [];
      
      for (const section of config) {
        if (section.param === 'Include' && section.value) {
          const includePaths = this.expandIncludePath(section.value, configPath);
          
          for (const includePath of includePaths) {
            const includeHosts = await this.processIncludeDirectives(includePath);
            hosts.push(...includeHosts);
          }
        }
      }
      
      // Add hosts from the current config file
      const currentHosts = this.extractHostsFromConfig(config, configPath);
      hosts.push(...currentHosts);
      
      return hosts;
    } catch (error) {
      debugLog(`Error processing config file ${configPath}: ${error.message}\n`);
      return [];
    }
  }

  expandIncludePath(includePath, baseConfigPath) {
    const { dirname, resolve, isAbsolute, win32 } = require('path');
    const { glob } = require('glob');
    const { existsSync } = require('fs');
    
    // Handle tilde expansion
    if (/^~(?=[\\/])/.test(includePath)) {
      includePath = includePath.replace(/^~/, homedir());
    }
    
    // Handle relative paths
    if (!isAbsolute(includePath) && !win32.isAbsolute(includePath)) {
      const baseDir = dirname(baseConfigPath);
      includePath = resolve(baseDir, includePath);
    }
    
    try {
      // Handle glob patterns
      if (includePath.includes('*') || includePath.includes('?')) {
        return glob.sync(includePath).filter(path => existsSync(path));
      } else {
        return existsSync(includePath) ? [includePath] : [];
      }
    } catch (error) {
      debugLog(`Error expanding include path ${includePath}: ${error.message}\n`);
      return [];
    }
  }

  async checkFilePermissions(filePath) {
    // Windows doesn't support Unix file permissions - skip check
    if (isWindows) return;
    try {
      const fileStat = await stat(filePath);
      const mode = fileStat.mode & 0o777;
      if (mode !== 0o600) {
        throw new Error(
          `SSH config file ${filePath} contains @password annotations but has insecure permissions (${mode.toString(8)}). ` +
          `Required: 600. Fix with: chmod 600 ${filePath}`
        );
      }
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
  }

  extractHostsFromConfig(config, configPath) {
    const hosts = [];
    let hasPasswords = false;

    for (const section of config) {
      // Skip Include directives as they are processed separately
      if (section.param === 'Include') {
        continue;
      }

      if (section.param === 'Host' && section.value !== '*') {
        const hostInfo = {
          hostname: '',
          alias: section.value,
          configFile: configPath
        };

        // Search all entries for this host
        for (const param of section.config) {
          // Parse @password annotation from comments
          if (param.type === 2 && param.content) {
            const match = param.content.match(/^#\s*@password:\s*(.+)$/);
            if (match) {
              hostInfo._password = match[1];
              hasPasswords = true;
              continue;
            }
          }

          // Safety check for undefined param
          if (!param || !param.param) {
            continue;
          }

          switch (param.param.toLowerCase()) {
            case 'hostname':
              hostInfo.hostname = param.value;
              break;
            case 'user':
              hostInfo.user = param.value;
              break;
            case 'port':
              hostInfo.port = parseInt(param.value, 10);
              break;
            case 'identityfile':
              hostInfo.identityFile = param.value;
              break;
            default:
              // Store other parameters
              hostInfo[param.param.toLowerCase()] = param.value;
          }
        }

        // Only add hosts with complete information
        if (hostInfo.hostname) {
          hosts.push(hostInfo);
        }
      }
    }

    // Store whether this config has passwords (for permission check)
    if (hasPasswords) {
      this._configsWithPasswords = this._configsWithPasswords || new Set();
      this._configsWithPasswords.add(configPath);
    }

    return hosts;
  }

  async parseKnownHosts() {
    try {
      const content = await readFile(this.knownHostsPath, 'utf-8');
      const knownHosts = content
        .split('\n')
        .filter(line => line.trim() !== '')
        .map(line => {
          // Format: hostname[,hostname2...] key-type public-key
          const parts = line.split(' ')[0];
          return parts.split(',')[0];
        });

      return knownHosts;
    } catch (error) {
      debugLog(`Error reading known_hosts file: ${error.message}\n`);
      return [];
    }
  }

  async getAllKnownHosts() {
    // First: Get all hosts from ~/.ssh/config including Include directives (these are prioritized)
    const configHosts = await this.processIncludeDirectives(this.configPath);

    // Check file permissions for configs that contain @password annotations
    if (this._configsWithPasswords) {
      for (const configPath of this._configsWithPasswords) {
        await this.checkFilePermissions(configPath);
      }
    }

    // Second: Get hostnames from ~/.ssh/known_hosts
    const knownHostnames = await this.parseKnownHosts();

    // Create a comprehensive list starting with config hosts
    const allHosts = [...configHosts];

    // Add hosts from known_hosts that aren't already in the config
    // These will appear after the config hosts
    for (const hostname of knownHostnames) {
      if (!configHosts.some(host => 
          host.hostname === hostname || 
          host.alias === hostname)) {
        allHosts.push({
          hostname: hostname,
          source: 'known_hosts'
        });
      }
    }

    // Mark config hosts for clarity
    configHosts.forEach(host => {
      host.source = 'ssh_config';
    });

    return allHosts;
  }
}

// SSH Client Implementation
class SSHClient {
  constructor() {
    this.configParser = new SSHConfigParser();
    this._askpassScript = null;
    this._spawn = spawn;
    this._execFileAsync = execFileAsync;
  }

  async listKnownHosts() {
    return await this.configParser.getAllKnownHosts();
  }

  _assertSafeHostAlias(hostAlias) {
    if (typeof hostAlias !== 'string' || hostAlias.length === 0) {
      throw new Error('hostAlias must be a non-empty string');
    }
    // Strict whitelist. Two threats this defends against:
    //   1. ssh/scp option injection via leading '-' (e.g. -oProxyCommand=…),
    //      which would execute arbitrary commands LOCALLY on this machine.
    //   2. cmd.exe metacharacter injection on Windows, where spawnOptions.shell
    //      is true and characters like &, |, ^, >, " would otherwise be
    //      interpreted by the shell before ssh.exe ever sees them.
    // Allowed: alphanumerics, '.', '_', '-', ':', '@'. Must not start with '-'.
    if (!/^[A-Za-z0-9_.@:][A-Za-z0-9._@:-]*$/.test(hostAlias)) {
      throw new Error(
        `Invalid hostAlias: must match [A-Za-z0-9._@:-] and not start with '-'`
      );
    }
  }

  async _assertKnownHostAlias(hostAlias) {
    const cleanAlias = hostAlias.includes('@') ? hostAlias.split('@').pop() : hostAlias;
    const knownHosts = await this.configParser.getAllKnownHosts();
    const isKnown = knownHosts.some((host) =>
      host.alias === hostAlias ||
      host.hostname === hostAlias ||
      host.alias === cleanAlias ||
      host.hostname === cleanAlias
    );
    if (!isKnown) {
      throw new Error(`Unknown hostAlias: ${hostAlias} is not defined in ~/.ssh/config or ~/.ssh/known_hosts`);
    }
  }

  async getPasswordForHost(hostAlias) {
    // Strip user@ prefix if present (e.g. "test@ssh-test" -> "ssh-test")
    const cleanAlias = hostAlias.includes('@') ? hostAlias.split('@').pop() : hostAlias;
    const hosts = await this.configParser.processIncludeDirectives(this.configParser.configPath);
    const host = hosts.find(h => h.alias === cleanAlias || h.hostname === cleanAlias);
    return host?._password || null;
  }

  async getAskpassScript() {
    if (this._askpassScript) return this._askpassScript;

    const { tmpdir } = require('os');
    let scriptPath;
    if (isWindows) {
      scriptPath = join(tmpdir(), `mcp-ssh-askpass-${process.pid}.cmd`);
      await writeFile(scriptPath, '@echo off\r\necho %MCP_SSH_PASS%\r\n');
    } else {
      scriptPath = join(tmpdir(), `mcp-ssh-askpass-${process.pid}.sh`);
      await writeFile(scriptPath, '#!/bin/sh\necho "$MCP_SSH_PASS"\n');
      await chmod(scriptPath, 0o700);
    }
    this._askpassScript = scriptPath;

    // Clean up on exit
    const cleanup = () => { try { require('fs').unlinkSync(scriptPath); } catch {} };
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(130); });
    process.on('SIGTERM', () => { cleanup(); process.exit(143); });

    return scriptPath;
  }

  async buildSpawnEnv(hostAlias) {
    const password = await this.getPasswordForHost(hostAlias);
    if (!password) return null;

    // Check file permissions before using password
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
      SSH_ASKPASS_REQUIRE: 'force'
    };
  }

  async runRemoteCommand(hostAlias, command, options = {}) {
    this._assertSafeHostAlias(hostAlias);
    await this._assertKnownHostAlias(hostAlias);
    const timeout = options.timeout || 30000;
    const MAX_OUTPUT_SIZE = 10 * 1024 * 1024; // 10MB limit

    debugLog(`Executing: ssh ${hostAlias} ${command}\n`);

    const passwordEnv = await this.buildSpawnEnv(hostAlias);

    return new Promise((resolve) => {
      const spawnOptions = {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // shell:false is critical on Windows: with shell:true the args would
        // be re-parsed by cmd.exe and metacharacters in `command` could lead
        // to local command injection. We rely on resolveExecutable() to find
        // ssh.exe on Windows so PATH lookup is not needed.
        shell: false
      };
      if (passwordEnv) {
        spawnOptions.env = passwordEnv;
        if (!isWindows) {
          // setsid needed on some systems so SSH uses SSH_ASKPASS instead of tty
          spawnOptions.detached = true;
        }
      }

      const child = this._spawn(SSH_BIN, ['-o', 'StrictHostKeyChecking=accept-new', '--', hostAlias, command], spawnOptions);

      let stdout = '';
      let stderr = '';
      let killed = false;
      let stdoutTruncated = false;
      let stderrTruncated = false;

      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGTERM');
      }, timeout);

      child.stdout.on('data', (data) => {
        if (stdout.length < MAX_OUTPUT_SIZE) {
          stdout += data.toString();
        } else if (!stdoutTruncated) {
          stdoutTruncated = true;
          stdout += '\n[Output truncated - exceeded 10MB limit]';
        }
      });

      child.stderr.on('data', (data) => {
        if (stderr.length < MAX_OUTPUT_SIZE) {
          stderr += data.toString();
        } else if (!stderrTruncated) {
          stderrTruncated = true;
          stderr += '\n[Stderr truncated - exceeded 10MB limit]';
        }
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          stdout,
          stderr: killed ? stderr + '\n[Command timed out]' : stderr,
          code: killed ? 124 : (code || 0)
        });
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        debugLog(`Error executing command on ${hostAlias}: ${error.message}\n`);
        resolve({
          stdout,
          stderr: error.message,
          code: 1
        });
      });
    });
  }

  async getHostInfo(hostAlias) {
    const hosts = await this.configParser.processIncludeDirectives(this.configParser.configPath);
    const host = hosts.find(host => host.alias === hostAlias || host.hostname === hostAlias) || null;
    if (host) {
      // Never expose password to the LLM
      const { _password, ...safeHost } = host;
      if (_password) safeHost.passwordAuth = true;
      return safeHost;
    }
    return null;
  }

  async checkConnectivity(hostAlias) {
    try {
      // Simple connectivity test using ssh
      const result = await this.runRemoteCommand(hostAlias, 'echo connected');
      const connected = result.code === 0 && result.stdout.trim() === 'connected';
      
      return {
        connected,
        message: connected ? 'Connection successful' : 'Connection failed'
      };
    } catch (error) {
      debugLog(`Connectivity error with ${hostAlias}: ${error.message}\n`);
      return {
        connected: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async uploadFile(hostAlias, localPath, remotePath) {
    try {
      this._assertSafeHostAlias(hostAlias);
      await this._assertKnownHostAlias(hostAlias);
      debugLog(`Executing: scp ${localPath} ${hostAlias}:${remotePath}\n`);

      const passwordEnv = await this.buildSpawnEnv(hostAlias);
      const options = { timeout: 60000, windowsHide: true, shell: false };
      if (passwordEnv) options.env = passwordEnv;

      await this._execFileAsync(SCP_BIN, ['-o', 'StrictHostKeyChecking=accept-new', '--', localPath, `${hostAlias}:${remotePath}`], options);
      return true;
    } catch (error) {
      debugLog(`Error uploading file to ${hostAlias}: ${error.message}\n`);
      return false;
    }
  }

  async downloadFile(hostAlias, remotePath, localPath) {
    try {
      this._assertSafeHostAlias(hostAlias);
      await this._assertKnownHostAlias(hostAlias);
      debugLog(`Executing: scp ${hostAlias}:${remotePath} ${localPath}\n`);

      const passwordEnv = await this.buildSpawnEnv(hostAlias);
      const options = { timeout: 60000, windowsHide: true, shell: false };
      if (passwordEnv) options.env = passwordEnv;

      await this._execFileAsync(SCP_BIN, ['-o', 'StrictHostKeyChecking=accept-new', '--', `${hostAlias}:${remotePath}`, localPath], options);
      return true;
    } catch (error) {
      debugLog(`Error downloading file from ${hostAlias}: ${error.message}\n`);
      return false;
    }
  }

  async runCommandBatch(hostAlias, commands) {
    try {
      const results = [];
      let success = true;
      
      for (const command of commands) {
        const result = await this.runRemoteCommand(hostAlias, command);
        results.push(result);
        
        if (result.code !== 0) {
          success = false;
          // Continue executing remaining commands
        }
      }
      
      return {
        results,
        success
      };
    } catch (error) {
      debugLog(`Error during batch execution on ${hostAlias}: ${error.message}\n`);
      return {
        results: [{
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          code: 1
        }],
        success: false
      };
    }
  }
}

// Main function to start the MCP server
async function main() {
  try {
    // Create an instance of the SSH client
    debugLog("Initializing SSH client...\n");
    const sshClient = new SSHClient();

    debugLog("Creating MCP server...\n");
    // Create an MCP server
    const server = new Server(
      { name: "mcp-ssh", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );

    debugLog("Setting up request handlers...\n");
    // Handler for listing available tools
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      debugLog("Received listTools request\n");
      return {
        tools: [
          {
            name: "listKnownHosts",
            description: "Returns a consolidated list of all known SSH hosts, prioritizing ~/.ssh/config entries first, then additional hosts from ~/.ssh/known_hosts",
            inputSchema: {
              type: "object",
              properties: {},
              required: [],
            },
          },
          {
            name: "runRemoteCommand",
            description: "Executes a shell command on an SSH host. For long-running commands, increase the timeout parameter.",
            inputSchema: {
              type: "object",
              properties: {
                hostAlias: {
                  type: "string",
                  description: "Alias or hostname of the SSH host",
                },
                command: {
                  type: "string",
                  description: "The shell command to execute",
                },
                timeout: {
                  type: "number",
                  description: "Command timeout in milliseconds (default: 120000, max: 300000)",
                },
              },
              required: ["hostAlias", "command"],
            },
          },
          {
            name: "getHostInfo",
            description: "Returns all configuration details for an SSH host",
            inputSchema: {
              type: "object",
              properties: {
                hostAlias: {
                  type: "string",
                  description: "Alias or hostname of the SSH host",
                },
              },
              required: ["hostAlias"],
            },
          },
          {
            name: "checkConnectivity",
            description: "Checks if an SSH connection to the host is possible",
            inputSchema: {
              type: "object",
              properties: {
                hostAlias: {
                  type: "string",
                  description: "Alias or hostname of the SSH host",
                },
              },
              required: ["hostAlias"],
            },
          },
          {
            name: "uploadFile",
            description: "Uploads a local file to an SSH host",
            inputSchema: {
              type: "object",
              properties: {
                hostAlias: {
                  type: "string",
                  description: "Alias or hostname of the SSH host",
                },
                localPath: {
                  type: "string",
                  description: "Path to the local file",
                },
                remotePath: {
                  type: "string",
                  description: "Path on the remote host",
                },
              },
              required: ["hostAlias", "localPath", "remotePath"],
            },
          },
          {
            name: "downloadFile",
            description: "Downloads a file from an SSH host",
            inputSchema: {
              type: "object",
              properties: {
                hostAlias: {
                  type: "string",
                  description: "Alias or hostname of the SSH host",
                },
                remotePath: {
                  type: "string",
                  description: "Path on the remote host",
                },
                localPath: {
                  type: "string",
                  description: "Path to the local destination",
                },
              },
              required: ["hostAlias", "remotePath", "localPath"],
            },
          },
          {
            name: "runCommandBatch",
            description: "Executes multiple shell commands sequentially on an SSH host",
            inputSchema: {
              type: "object",
              properties: {
                hostAlias: {
                  type: "string",
                  description: "Alias or hostname of the SSH host",
                },
                commands: {
                  type: "array",
                  items: { type: "string" },
                  description: "List of shell commands to execute",
                },
              },
              required: ["hostAlias", "commands"],
            },
          },
        ],
      };
    });

    // Handler for tool calls
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      debugLog(`Received callTool request for tool: ${name}\n`);

      if (!args && name !== "listKnownHosts") {
        throw new Error(`No arguments provided for tool: ${name}`);
      }

      try {
        switch (name) {
          case "listKnownHosts": {
            const hosts = await sshClient.listKnownHosts();
            // Strip passwords before sending to LLM
            const safeHosts = hosts.map(({ _password, ...host }) => {
              if (_password) host.passwordAuth = true;
              return host;
            });
            return {
              content: [{ type: "text", text: JSON.stringify(safeHosts, null, 2) }],
            };
          }

          case "runRemoteCommand": {
            const timeout = Math.min(args.timeout || 120000, 300000); // Default 2 min, cap at 5 min
            const result = await sshClient.runRemoteCommand(
              args.hostAlias,
              args.command,
              { timeout }
            );
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
          }

          case "getHostInfo": {
            const hostInfo = await sshClient.getHostInfo(args.hostAlias);
            return {
              content: [{ type: "text", text: JSON.stringify(hostInfo, null, 2) }],
            };
          }

          case "checkConnectivity": {
            const status = await sshClient.checkConnectivity(args.hostAlias);
            return {
              content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
            };
          }

          case "uploadFile": {
            const success = await sshClient.uploadFile(
              args.hostAlias,
              args.localPath,
              args.remotePath
            );
            return {
              content: [{ type: "text", text: JSON.stringify({ success }, null, 2) }],
            };
          }

          case "downloadFile": {
            const success = await sshClient.downloadFile(
              args.hostAlias,
              args.remotePath,
              args.localPath
            );
            return {
              content: [{ type: "text", text: JSON.stringify({ success }, null, 2) }],
            };
          }

          case "runCommandBatch": {
            const result = await sshClient.runCommandBatch(
              args.hostAlias,
              args.commands
            );
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
          }

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        debugLog(`Error executing tool ${name}: ${error.message}\n`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    });

    debugLog("Starting MCP SSH Agent on STDIO...\n");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    debugLog("MCP SSH Agent connected and ready!\n");
    
  } catch (error) {
    debugLog(`Error starting MCP SSH Agent: ${error.message}\n`);
    process.exit(1);
  }
}

// Export classes and main() for the bin wrapper and tests.
// We do NOT auto-start main() based on a process.argv[1] heuristic — that
// check was unreliable on Windows (backslashes vs forward slashes) and
// caused the server to silently exit when launched via bin/mcp-ssh.js on
// Windows MCP clients (issue #8). The bin wrapper now imports and calls
// main() explicitly.
export { SSHConfigParser, SSHClient, debugLog, main };

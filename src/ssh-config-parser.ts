/**
 * Discovery of SSH hosts from ~/.ssh/config (including Include directives) and
 * ~/.ssh/known_hosts.
 */
import { homedir } from 'node:os';
import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { existsSync } from 'node:fs';
import { glob } from 'glob';
import SSHConfig from 'ssh-config';

import { debugLog, isWindows } from './platform.js';
import { configValueTokens, configValueToString, hostMatchesAlias } from './config-values.js';
import type { ConfigValue } from './config-values.js';
import type { HostInfo } from './types.js';

/** Shape of a parsed ssh-config line, narrowed to what we consume. */
interface ConfigLine {
  type?: number;
  param?: string;
  value?: ConfigValue;
  content?: string;
  config?: ConfigLine[];
}

const LINE_TYPE_COMMENT = 2;

export class SSHConfigParser {
  configPath: string;
  knownHostsPath: string;
  /** Config files that carry `# @password:` annotations, for the permission check. */
  _configsWithPasswords?: Set<string>;

  constructor() {
    const homeDir = homedir();
    this.configPath = join(homeDir, '.ssh', 'config');
    this.knownHostsPath = join(homeDir, '.ssh', 'known_hosts');
  }

  async parseConfig(): Promise<HostInfo[]> {
    try {
      const content = await readFile(this.configPath, 'utf-8');
      const config = SSHConfig.parse(content) as unknown as ConfigLine[];
      return this.extractHostsFromConfig(config, this.configPath);
    } catch (error) {
      debugLog(`Error reading SSH config: ${errorMessage(error)}\n`);
      return [];
    }
  }

  async processIncludeDirectives(configPath: string): Promise<HostInfo[]> {
    try {
      const content = await readFile(configPath, 'utf-8');
      const config = SSHConfig.parse(content) as unknown as ConfigLine[];
      const hosts: HostInfo[] = [];

      for (const section of config) {
        if (section.param === 'Include' && section.value) {
          const includePaths = this.expandIncludePath(configValueToString(section.value), configPath);

          for (const includePath of includePaths) {
            const includeHosts = await this.processIncludeDirectives(includePath);
            hosts.push(...includeHosts);
          }
        }
      }

      // Add hosts from the current config file
      hosts.push(...this.extractHostsFromConfig(config, configPath));

      return hosts;
    } catch (error) {
      debugLog(`Error processing config file ${configPath}: ${errorMessage(error)}\n`);
      return [];
    }
  }

  expandIncludePath(includePath: string, baseConfigPath: string): string[] {
    // Handle tilde expansion
    if (/^~(?=[\\/])/.test(includePath)) {
      includePath = includePath.replace(/^~/, homedir());
    }

    // Handle relative paths. Both checks are needed: a Windows drive-letter or
    // UNC path is absolute even when this runs on POSIX.
    if (!isAbsolute(includePath) && !win32.isAbsolute(includePath)) {
      includePath = resolve(dirname(baseConfigPath), includePath);
    }

    try {
      if (includePath.includes('*') || includePath.includes('?')) {
        return glob.sync(includePath).filter(path => existsSync(path));
      }
      return existsSync(includePath) ? [includePath] : [];
    } catch (error) {
      debugLog(`Error expanding include path ${includePath}: ${errorMessage(error)}\n`);
      return [];
    }
  }

  async checkFilePermissions(filePath: string): Promise<void> {
    // Windows has no Unix permission bits - skip check
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
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  extractHostsFromConfig(config: ConfigLine[], configPath: string): HostInfo[] {
    const hosts: HostInfo[] = [];
    let hasPasswords = false;

    for (const section of config) {
      // Include directives are processed separately
      if (section.param === 'Include') continue;
      if (section.param !== 'Host') continue;

      const aliases = configValueTokens(section.value);
      const [firstAlias] = aliases;

      // Skip blocks that only carry defaults (`Host *`, `Host * !bastion`):
      // they are not connectable hosts. A multi-token Host value is an array,
      // so a plain `value !== '*'` check could never match these. An empty
      // value (no alias at all) is skipped by the same guard.
      if (!firstAlias || aliases.every(a => a === '*' || a.startsWith('!'))) {
        continue;
      }

      const hostInfo: HostInfo = {
        hostname: '',
        alias: firstAlias,   // first alias — keeps the existing output shape
        aliases,             // full list — used for matching
        configFile: configPath,
      };

      for (const param of section.config ?? []) {
        // Parse @password annotation from comments
        if (param.type === LINE_TYPE_COMMENT && param.content) {
          const match = /^#\s*@password:\s*(.+)$/.exec(param.content);
          if (match?.[1]) {
            hostInfo._password = match[1];
            hasPasswords = true;
            continue;
          }
        }

        // Comments that are not @password annotations, and anything else
        // without a directive name, carry nothing we can store.
        if (!param.param) continue;

        // Multi-token directives (ProxyCommand, SendEnv, IPQoS, …) arrive as
        // arrays of token objects; flatten so the JSON we hand back is readable.
        const value = configValueToString(param.value);

        switch (param.param.toLowerCase()) {
          case 'hostname':
            hostInfo.hostname = value;
            break;
          case 'user':
            hostInfo.user = value;
            break;
          case 'port':
            hostInfo.port = parseInt(value, 10);
            break;
          case 'identityfile':
            hostInfo.identityFile = value;
            break;
          default:
            hostInfo[param.param.toLowerCase()] = value;
        }
      }

      // Only add hosts with complete information
      if (hostInfo.hostname) hosts.push(hostInfo);
    }

    if (hasPasswords) {
      this._configsWithPasswords ??= new Set<string>();
      this._configsWithPasswords.add(configPath);
    }

    return hosts;
  }

  async parseKnownHosts(): Promise<string[]> {
    try {
      const content = await readFile(this.knownHostsPath, 'utf-8');
      return content
        .split('\n')
        .filter(line => line.trim() !== '')
        // Format: hostname[,hostname2...] key-type public-key
        // Both splits are guaranteed to yield at least one element, so the
        // assertions cannot fail — a `?? ''` fallback here would be dead code.
        .map(line => line.split(' ')[0]!.split(',')[0]!);
    } catch (error) {
      debugLog(`Error reading known_hosts file: ${errorMessage(error)}\n`);
      return [];
    }
  }

  async getAllKnownHosts(): Promise<HostInfo[]> {
    // Config hosts are prioritized, including everything pulled in via Include
    const configHosts = await this.processIncludeDirectives(this.configPath);

    // Check file permissions for configs that contain @password annotations
    if (this._configsWithPasswords) {
      for (const configPath of this._configsWithPasswords) {
        await this.checkFilePermissions(configPath);
      }
    }

    const knownHostnames = await this.parseKnownHosts();
    const allHosts: HostInfo[] = [...configHosts];

    // Add hosts from known_hosts that aren't already in the config
    for (const hostname of knownHostnames) {
      if (!configHosts.some(host => hostMatchesAlias(host, hostname))) {
        allHosts.push({ hostname, source: 'known_hosts' });
      }
    }

    configHosts.forEach(host => {
      host.source = 'ssh_config';
    });

    return allHosts;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * MCP tool definitions and dispatch.
 *
 * Argument values arrive from the LLM and are therefore untrusted: every path
 * that reaches ssh/scp goes through SSHClient's validation. Nothing is
 * pre-validated here beyond what the schemas declare.
 */
import type { SSHClient } from './ssh-client.js';
import { debugLog } from './platform.js';

const HOST_ALIAS_PROPERTY = {
  type: 'string',
  description: 'Alias or hostname of the SSH host',
} as const;

export const TOOL_DEFINITIONS = [
  {
    name: 'listKnownHosts',
    description:
      'Returns a consolidated list of all known SSH hosts, prioritizing ~/.ssh/config entries first, then additional hosts from ~/.ssh/known_hosts',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'runRemoteCommand',
    description:
      'Executes a shell command on an SSH host. For long-running commands, increase the timeout parameter.',
    inputSchema: {
      type: 'object',
      properties: {
        hostAlias: HOST_ALIAS_PROPERTY,
        command: { type: 'string', description: 'The shell command to execute' },
        timeout: {
          type: 'number',
          description: 'Command timeout in milliseconds (default: 120000, max: 300000)',
        },
      },
      required: ['hostAlias', 'command'],
    },
  },
  {
    name: 'getHostInfo',
    description: 'Returns all configuration details for an SSH host',
    inputSchema: {
      type: 'object',
      properties: { hostAlias: HOST_ALIAS_PROPERTY },
      required: ['hostAlias'],
    },
  },
  {
    name: 'checkConnectivity',
    description: 'Checks if an SSH connection to the host is possible',
    inputSchema: {
      type: 'object',
      properties: { hostAlias: HOST_ALIAS_PROPERTY },
      required: ['hostAlias'],
    },
  },
  {
    name: 'uploadFile',
    description: 'Uploads a local file to an SSH host',
    inputSchema: {
      type: 'object',
      properties: {
        hostAlias: HOST_ALIAS_PROPERTY,
        localPath: { type: 'string', description: 'Path to the local file' },
        remotePath: { type: 'string', description: 'Path on the remote host' },
      },
      required: ['hostAlias', 'localPath', 'remotePath'],
    },
  },
  {
    name: 'downloadFile',
    description: 'Downloads a file from an SSH host',
    inputSchema: {
      type: 'object',
      properties: {
        hostAlias: HOST_ALIAS_PROPERTY,
        remotePath: { type: 'string', description: 'Path on the remote host' },
        localPath: { type: 'string', description: 'Path to the local destination' },
      },
      required: ['hostAlias', 'remotePath', 'localPath'],
    },
  },
  {
    name: 'runCommandBatch',
    description: 'Executes multiple shell commands sequentially on an SSH host',
    inputSchema: {
      type: 'object',
      properties: {
        hostAlias: HOST_ALIAS_PROPERTY,
        commands: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of shell commands to execute',
        },
      },
      required: ['hostAlias', 'commands'],
    },
  },
] as const;

/**
 * The MCP content envelope every tool result is wrapped in. The index signature
 * is what makes this assignable to the SDK's ServerResult union.
 */
export interface ToolResponse {
  content: { type: 'text'; text: string }[];
  [key: string]: unknown;
}

type ToolArgs = Record<string, unknown>;

const DEFAULT_COMMAND_TIMEOUT = 120000; // 2 min
const MAX_COMMAND_TIMEOUT = 300000; // 5 min

function asText(payload: unknown): ToolResponse {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Run one tool call. Errors are returned as a JSON payload rather than thrown,
 * so the model sees what went wrong instead of a transport-level failure.
 */
export async function callTool(
  sshClient: SSHClient,
  name: string,
  args: ToolArgs | undefined,
): Promise<ToolResponse> {
  debugLog(`Received callTool request for tool: ${name}\n`);

  if (!args && name !== 'listKnownHosts') {
    throw new Error(`No arguments provided for tool: ${name}`);
  }
  const a: ToolArgs = args ?? {};

  try {
    switch (name) {
      case 'listKnownHosts': {
        const hosts = await sshClient.listKnownHosts();
        // Strip passwords before sending to the LLM
        const safeHosts = hosts.map(({ _password, ...host }) =>
          _password ? { ...host, passwordAuth: true as const } : host
        );
        return asText(safeHosts);
      }

      case 'runRemoteCommand': {
        // Falsy (absent, 0) falls back to the default; `??` would let 0 through
        // and ask ssh for a zero-millisecond timeout.
        const requested = a['timeout'] as number | undefined;
        const timeout = Math.min(
          requested ? requested : DEFAULT_COMMAND_TIMEOUT,
          MAX_COMMAND_TIMEOUT,
        );
        return asText(
          await sshClient.runRemoteCommand(a['hostAlias'] as string, a['command'] as string, {
            timeout,
          }),
        );
      }

      case 'getHostInfo':
        return asText(await sshClient.getHostInfo(a['hostAlias'] as string));

      case 'checkConnectivity':
        return asText(await sshClient.checkConnectivity(a['hostAlias'] as string));

      case 'uploadFile': {
        const success = await sshClient.uploadFile(
          a['hostAlias'] as string,
          a['localPath'] as string,
          a['remotePath'] as string,
        );
        return asText({ success });
      }

      case 'downloadFile': {
        const success = await sshClient.downloadFile(
          a['hostAlias'] as string,
          a['remotePath'] as string,
          a['localPath'] as string,
        );
        return asText({ success });
      }

      case 'runCommandBatch':
        return asText(
          await sshClient.runCommandBatch(a['hostAlias'] as string, a['commands'] as string[]),
        );

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugLog(`Error executing tool ${name}: ${message}\n`);
    return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
  }
}

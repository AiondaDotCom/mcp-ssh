/**
 * MCP SSH Agent — entry point.
 *
 * Runs over STDIO. main() is exported rather than auto-started: an
 * `is this module run directly?` check based on process.argv[1] was unreliable
 * on Windows (backslashes vs forward slashes) and made the server exit silently
 * under Windows MCP clients (issue #8). bin/mcp-ssh.js imports and calls it.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { SSHClient } from './ssh-client.js';
import { debugLog } from './platform.js';
import { TOOL_DEFINITIONS, callTool } from './tools.js';

export async function main(): Promise<void> {
  try {
    debugLog('Initializing SSH client...\n');
    const sshClient = new SSHClient();

    debugLog('Creating MCP server...\n');
    // The SDK marks the low-level Server as deprecated in favour of McpServer.
    // Migrating changes the registration API and is deliberately out of scope
    // for the TypeScript port.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const server = new Server(
      { name: 'mcp-ssh', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );

    debugLog('Setting up request handlers...\n');
    server.setRequestHandler(ListToolsRequestSchema, () => {
      debugLog('Received listTools request\n');
      return { tools: TOOL_DEFINITIONS };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      return callTool(sshClient, name, args);
    });

    debugLog('Starting MCP SSH Agent on STDIO...\n');
    const transport = new StdioServerTransport();
    await server.connect(transport);
    debugLog('MCP SSH Agent connected and ready!\n');
  } catch (error) {
    debugLog(`Error starting MCP SSH Agent: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

export { SSHClient } from './ssh-client.js';
export { SSHConfigParser } from './ssh-config-parser.js';
export { debugLog, SSH_BIN, SCP_BIN } from './platform.js';
export { TOOL_DEFINITIONS, callTool } from './tools.js';
export * from './types.js';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      // server.mjs is the whole production implementation (it is deliberately
      // self-contained — see CLAUDE.md). bin/mcp-ssh.js is excluded: it is a
      // top-level-await wrapper whose only job is to call main(), so importing
      // it in a unit test would start a real MCP server on STDIO.
      include: ['server.mjs'],
      reporter: ['text', 'json-summary', 'html'],
      // The suite covers every line, branch and function of server.mjs, on both
      // the POSIX and the Windows code paths. Keep it that way.
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});

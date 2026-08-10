import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Windows CI runners are markedly slower than a dev machine, and a few tests
    // allocate 10MB buffers or re-import the module graph. The 5s default left
    // too little headroom.
    testTimeout: 15000,
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // The production sources. bin/mcp-ssh.js is excluded: it is a
      // top-level-await wrapper whose only job is to call main(), so importing
      // it in a unit test would start a real MCP server on STDIO. types.ts is
      // excluded because it compiles to nothing executable.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/test-helpers.ts', 'src/types.ts'],
      reporter: ['text', 'json-summary', 'html'],
      // The suite covers every line, branch and function, on both the POSIX and
      // the Windows code paths. Keep it that way.
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
});

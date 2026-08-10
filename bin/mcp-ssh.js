#!/usr/bin/env node

// Wrapper that runs the compiled server (dist/server.js, built from src/ by tsc).
// We import main() explicitly and call it here instead of relying on a
// "is this module run directly?" check inside the server module. The latter is
// brittle on Windows because process.argv[1] uses backslashes while the
// check used forward-slash suffixes (fixes #8).
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, '..', 'dist', 'server.js');

if (!existsSync(serverPath)) {
  console.error(
    `mcp-ssh: ${serverPath} is missing. Run "npm run build" first ` +
    `(this happens automatically on npm install from a git checkout).`
  );
  process.exit(1);
}

const { main } = await import(pathToFileURL(serverPath).href);

main().catch((error) => {
  console.error(`Unhandled error: ${error?.message ?? error}`);
  process.exit(1);
});

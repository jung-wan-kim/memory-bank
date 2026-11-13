#!/usr/bin/env node
/**
 * MCP Server for Memory Bank — the stdio entry point (dist/mcp-server.js), started once per session.
 *
 * It is a relay by default: the tools run in a shared server process that sessions with the same settings
 * use together (shared-server.ts), and this process only passes MCP lines to it (relay.ts). Where a shared
 * server cannot be used it runs the whole server itself, as every version before 1.9.0 did, and says so in
 * one line on stderr.
 *
 * This file is the esbuild bundle's entry. It must stay light — the relay loads no database and no model —
 * so the session-local server is imported by a path worked out at run time, which keeps it (and everything
 * under it) out of the bundle.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ownCwd } from './own-cwd.js';
import { runRelay } from './relay.js';
import { sharedMode, type SessionLocalReason } from './shared-mode.js';

const WHY_SESSION_LOCAL: Record<SessionLocalReason, string> = {
  'switch-off': 'MEMORY_BANK_SHARED_SERVER is off',
  'switch-off-file': 'shared-server.off is present in the index dir',
  windows: 'not available on Windows',
  'not-built': 'running from source, or dist/shared-server.js is missing',
  'no-version': 'the plugin version (package.json) cannot be read',
  'relative-path': 'a path setting is relative and this process has no working directory to resolve it against',
  'socket-path-too-long': 'the index dir path is too long for a unix socket — a shorter MEMORY_BANK_CONFIG_DIR / XDG_CONFIG_HOME turns it on',
};

async function main(): Promise<void> {
  // This process belongs to one session: its working directory is that session's project.
  const cwd = ownCwd();
  const mode = sharedMode({ entryUrl: import.meta.url, env: process.env, cwd });
  if (mode.kind === 'shared') {
    runRelay(mode, cwd);
    return;
  }
  console.error(`[memory-bank] shared server off: ${WHY_SESSION_LOCAL[mode.reason]} — this session runs its own server`);
  const entry = fileURLToPath(import.meta.url);
  const sessionLocal = path.join(path.dirname(entry), `stdio-server${path.extname(entry)}`);
  const { runStdioServer } = (await import(pathToFileURL(sessionLocal).href)) as typeof import('./stdio-server.js');
  await runStdioServer();
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});

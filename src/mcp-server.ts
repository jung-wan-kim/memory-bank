#!/usr/bin/env node
/**
 * MCP Server for Memory Bank — the stdio entry point (dist/mcp-server.js).
 *
 * The tools live in server-core.ts; this file only starts the server for the session that launched it.
 */
import { runStdioServer } from './stdio-server.js';

runStdioServer().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});

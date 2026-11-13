/**
 * The session-local way to run the MCP server: this process holds the whole server — database, embedding
 * model, the tools — and speaks MCP over its own stdin/stdout.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { startInjectDaemon } from './inject-daemon.js';
import { createMemoryBankServer } from './server-core.js';

export async function runStdioServer(): Promise<void> {
  console.error('Episodic Memory MCP server running via stdio');

  // Warm inject sidecar BEFORE connecting the transport: it lets the
  // UserPromptSubmit hook reuse this process's loaded embedding model over a
  // unix socket (~150ms warm vs ~2.3s cold). Starting it first means it is
  // available immediately and is never gated on server.connect() completing
  // (best-effort, unref'd — adds no lifecycle and never blocks MCP traffic).
  startInjectDaemon();
  const transport = new StdioServerTransport();
  await createMemoryBankServer().connect(transport);
}

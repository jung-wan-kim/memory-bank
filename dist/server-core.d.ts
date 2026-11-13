/**
 * The memory-bank MCP tools: what they are called, what they take, and what they answer.
 *
 * This module starts nothing when it is imported. createMemoryBankServer() builds one MCP server for one
 * session — the stdio entry (stdio-server.ts) makes one for its own process, and the shared server makes one
 * per connection.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
/** One MCP server with the memory-bank tools registered. Connect it to a transport to serve a session. */
export declare function createMemoryBankServer(): Server;

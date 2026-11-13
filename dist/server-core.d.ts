/**
 * The memory-bank MCP tools: what they are called, what they take, and what they answer.
 *
 * This module starts nothing when it is imported. createMemoryBankServer() builds one MCP server for one
 * session — the stdio entry (stdio-server.ts) makes one for its own process, and the shared server makes one
 * per connection.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { type SessionContext } from './session-context.js';
/**
 * One MCP server for one session, with the memory-bank tools registered. Connect it to a transport to serve
 * that session. `ctx.cwd` is the project the tools fall back to — the session's working directory, never
 * this process's. The same goes for what else is the session's alone: the environment of the LLM child its
 * calls start (`ctx.childEnv`) and the locale its output is written in (`ctx.locale`).
 */
export declare function createMemoryBankServer(ctx: SessionContext): Server;

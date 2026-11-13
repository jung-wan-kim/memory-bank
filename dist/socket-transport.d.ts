import type net from 'node:net';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
/**
 * MCP over one connection of the shared server's unix socket: newline-delimited JSON-RPC, the same framing as
 * stdio. The connection's first line (the hello) is not MCP and is handled before this transport exists; the
 * owner of the socket feeds every later line in through receive().
 */
export declare class SocketTransport implements Transport {
    private readonly socket;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;
    /** Lines that arrived before the MCP server took the transport over. */
    private pending;
    private closed;
    constructor(socket: net.Socket);
    start(): Promise<void>;
    /** One line from the peer, without its newline. */
    receive(line: string): void;
    private deliver;
    send(message: JSONRPCMessage): Promise<void>;
    close(): Promise<void>;
    /** The connection is gone (the owner of the socket saw it close). */
    peerClosed(): void;
}

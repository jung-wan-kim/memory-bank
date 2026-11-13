import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
/**
 * MCP over one connection of the shared server's unix socket: newline-delimited JSON-RPC, the same framing as
 * stdio. The connection's first line (the hello) is not MCP and is handled before this transport exists; the
 * owner of the socket feeds every later line in through receive().
 */
export class SocketTransport {
    socket;
    onclose;
    onerror;
    onmessage;
    /** Lines that arrived before the MCP server took the transport over. */
    pending = [];
    closed = false;
    constructor(socket) {
        this.socket = socket;
    }
    async start() {
        const pending = this.pending ?? [];
        this.pending = null;
        for (const line of pending)
            this.deliver(line);
    }
    /** One line from the peer, without its newline. */
    receive(line) {
        if (this.closed || line === '')
            return;
        if (this.pending !== null)
            this.pending.push(line);
        else
            this.deliver(line);
    }
    deliver(line) {
        let message;
        try {
            message = JSONRPCMessageSchema.parse(JSON.parse(line));
        }
        catch (error) {
            this.onerror?.(error instanceof Error ? error : new Error(String(error)));
            return;
        }
        this.onmessage?.(message);
    }
    async send(message) {
        // The session left while its call was running: there is nobody to answer.
        if (this.closed || this.socket.destroyed)
            return;
        this.socket.write(JSON.stringify(message) + '\n');
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        if (!this.socket.destroyed)
            this.socket.end();
        this.onclose?.();
    }
    /** The connection is gone (the owner of the socket saw it close). */
    peerClosed() {
        if (this.closed)
            return;
        this.closed = true;
        this.onclose?.();
    }
}

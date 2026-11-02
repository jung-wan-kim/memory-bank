import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Fake inject daemons for client tests (shared by inject-daemon-socket.test.ts and native-inject-client.test.ts —
 * extracted 2026-11-02 so the JS and the native client are judged against the same servers).
 *
 * Socket paths must stay short: a unix socket path is limited to 104 bytes on macOS, and os.tmpdir() is too deep.
 */
export function shortTmpDir(prefix = '/tmp/mbsk-'): string {
  const tmp = fs.mkdtempSync(prefix);
  fs.mkdirSync(path.join(tmp, 'conversation-index'), { recursive: true });
  return tmp;
}

/** Answers every request at once with {ok:true, context}. */
export function fakeDaemon(sockPath: string, context: string, servers: net.Server[] = []): Promise<net.Server> {
  return lineDaemon(sockPath, (_req, c) => c.end(JSON.stringify({ ok: true, context }) + '\n'), servers);
}

/** Runs `script` on the first bytes of each connection (the request line may still be partial). */
export function scriptedDaemon(sockPath: string, script: (c: net.Socket) => void, servers: net.Server[] = []): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer((c) => { c.on('error', () => {}); c.once('data', () => script(c)); });
    s.on('error', reject);
    s.listen(sockPath, () => { servers.push(s); resolve(s); });
  });
}

/** Parses the request line, then runs `script(req, c)`. The requests seen are kept on `received`. */
export function lineDaemon(
  sockPath: string,
  script: (req: Record<string, unknown>, c: net.Socket) => void,
  servers: net.Server[] = [],
  received: Array<Record<string, unknown>> = [],
): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer((c) => {
      let buf = '';
      c.setEncoding('utf8');
      c.on('error', () => {});
      c.on('data', (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        let req: Record<string, unknown> = {};
        try { req = JSON.parse(buf.slice(0, nl)); } catch { /* the script decides */ }
        received.push(req);
        script(req, c);
      });
    });
    s.on('error', reject);
    s.listen(sockPath, () => { servers.push(s); resolve(s); });
  });
}

export function closeAll(servers: net.Server[]): Promise<void> {
  return Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r())))).then(() => undefined);
}

export function readInjectLog(tmp: string): Array<Record<string, unknown>> {
  const f = path.join(tmp, 'conversation-index', 'logs', 'inject-context.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export function readLedger(tmp: string, sessionId: string): string | null {
  const f = path.join(tmp, 'conversation-index', 'state', 'inject-ledger', `${sessionId}.json`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
}

export async function waitFor(pred: () => boolean, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

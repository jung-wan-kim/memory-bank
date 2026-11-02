#!/usr/bin/env node
// e2e-native-inject-live.mjs — TC-E2E-001 runner (docs/qa-test-plan.md): the real MCP server of THIS checkout (its inject daemon on
// the versioned socket), the real index/DB, the real hook wrapper — 5 native vs 5 node runs with a fresh session id each (a repeated id
// is deduped into an empty block), then the inject-log lines they wrote. Writes .qa-artifacts/e2e-live.json and exits 0 only on PASS.
//   node scripts/e2e-native-inject-live.mjs [repo-root]      (default: the checkout this file lives in)
// Not part of npm test — it talks to the live daemon socket directory and the live inject log.
import fs from 'node:fs'; import os from 'node:os'; import net from 'node:net'; import path from 'node:path'; import { spawn, spawnSync } from 'node:child_process';
const REPO = process.argv[2] || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const INDEX = path.join(os.homedir(), '.config/superpowers/conversation-index');
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const SRC_HASH = fs.readFileSync(path.join(REPO, 'native/inject-client/SRC_HASH'), 'utf8').trim();
const { injectSocketPathIn } = await import(path.join(REPO, 'dist/version-guard.js'));
const sock = injectSocketPathIn(INDEX, VERSION);
const LOG = path.join(INDEX, 'logs/inject-context.jsonl');
const out = { head: spawnSync('git', ['-C', REPO, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).stdout.trim(), version: VERSION, src_hash: SRC_HASH, socket: path.basename(sock), steps: {} };
const say = (m) => console.log(m);
// step 1 — SessionStart build, same command string as hooks.json
const b = spawnSync('bash', [path.join(REPO, 'scripts/build-native-client.sh')], { encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: REPO } });
const BIN = path.join(INDEX, 'bin/memory-bank-inject-client');
const have = fs.existsSync(BIN + '.srchash') ? fs.readFileSync(BIN + '.srchash', 'utf8').trim() : null;
out.steps.build = { rc: b.status, stderr_line: (b.stderr || '').trim().split('\n').pop(), bin_exists: fs.existsSync(BIN), srchash: have, srchash_matches: have === SRC_HASH, bin_reports: spawnSync(BIN, ['--src-hash'], { encoding: 'utf8' }).stdout.trim() };
say(`step1 build: ${JSON.stringify(out.steps.build)}`);
if (!out.steps.build.srchash_matches) { say('ABORT: installed binary hash does not match'); process.exit(1); }
// step 2 — start the 1.7.9 server (its daemon binds the 1.7.9 socket; 1.7.8's live daemon has its own)
if (fs.existsSync(sock)) { // a live server answers the connect; a stale file (a killed server never unlinks it) refuses — reclaim it like the daemon itself does
  const live = await new Promise((r) => { const c = net.connect(sock); c.once('connect', () => { c.destroy(); r(true); }); c.once('error', () => r(false)); });
  if (live) { say(`socket ${sock} is answered by a live ${VERSION} server — aborting (would collide)`); process.exit(1); }
  fs.unlinkSync(sock); say(`stale socket ${path.basename(sock)} removed (connect refused)`);
}
const server = spawn('node', [path.join(REPO, 'dist/mcp-server.js')], { stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env } });
let serr = ''; server.stderr.on('data', (d) => { serr += d; });
const t0 = Date.now(); while (!fs.existsSync(sock) && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 200));
out.steps.server = { socket_up_ms: Date.now() - t0, socket_exists: fs.existsSync(sock), pid: server.pid };
say(`step2 server: ${JSON.stringify(out.steps.server)}`);
if (!fs.existsSync(sock)) { say('ABORT: daemon socket did not appear'); server.kill('SIGTERM'); process.exit(1); }
// A fresh session id per run: the per-session ledger dedups a second run of the same id into an EMPTY block, which
// would make the native-vs-node byte comparison vacuous (round-1 critique F1). All ids share one prefix for the log scan.
const sidBase = `e2e-native-${VERSION}-${Date.now().toString(36)}`; const sids = [];
const envelopeFor = (sid) => { sids.push(sid); return JSON.stringify({ prompt: 'memory-bank 플러그인의 프롬프트 주입 훅이 데몬 소켓으로 사실을 검색해 블록을 붙이는 과정을 설명해줘', cwd: REPO, session_id: sid, hook_event_name: 'UserPromptSubmit', transcript_path: '/tmp/e2e.jsonl' }); };
let runNo = 0;
function hook(extra) { return new Promise((res) => { const t = performance.now(); const c = spawn('bash', [path.join(REPO, 'hooks/inject-context.sh')], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...extra } }); let o = '', e = ''; c.stdout.on('data', (d) => { o += d; }); c.stderr.on('data', (d) => { e += d; }); c.on('close', (st) => res({ ms: performance.now() - t, status: st, stdout: o, stderr: e })); c.stdin.end(envelopeFor(`${sidBase}-${(runNo += 1)}`)); }); }
const logBefore = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).length : 0;
// warm-up: the daemon loads the embedding model on its first search ('warming' → the client waits up to 20s)
await new Promise((r) => setTimeout(r, 3000)); // let the machine settle (the full test suite may have just ended)
const warm = []; for (let i = 0; i < 5; i += 1) warm.push((await hook({})).ms);
out.steps.warmup_ms = warm.map((x) => Math.round(x));
const nat = [], node = [];
for (let i = 0; i < 5; i += 1) { nat.push(await hook({})); node.push(await hook({ MEMORY_BANK_NATIVE_CLIENT: '/nonexistent/memory-bank-inject-client' })); }
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
out.steps.loadavg = os.loadavg().map((x) => +x.toFixed(2));
out.steps.timing = { native_ms: nat.map((r) => +r.ms.toFixed(1)), node_ms: node.map((r) => +r.ms.toFixed(1)), native_median_ms: +med(nat.map((r) => r.ms)).toFixed(1), node_median_ms: +med(node.map((r) => r.ms)).toFixed(1), native_status: nat.map((r) => r.status), node_status: node.map((r) => r.status), same_stdout: nat.every((r) => r.stdout === node[0].stdout) && node.every((r) => r.stdout === node[0].stdout), stdout_chars: node[0].stdout.length, stdout_head: node[0].stdout.slice(0, 120), block_nonempty: node[0].stdout.length > 0 && nat.every((r) => r.stdout.length > 0) };
say(`step4 timing: ${JSON.stringify(out.steps.timing)}`);
await new Promise((r) => setTimeout(r, 500));
const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).slice(logBefore).map((l) => { try { return JSON.parse(l); } catch { return { parse_error: l.slice(0, 80) }; } });
const mine = lines.filter((l) => l.project === REPO);
out.steps.log = { new_lines: lines.length, mine: mine.length, plugin_versions: [...new Set(mine.map((l) => l.plugin_version))], client_impl: mine.reduce((a, l) => { a[l.client_impl ?? 'none'] = (a[l.client_impl ?? 'none'] || 0) + 1; return a; }, {}), via: [...new Set(mine.map((l) => l.via))], statuses: [...new Set(mine.map((l) => l.status))], session_id_plaintext_in_lines: fs.readFileSync(LOG, 'utf8').split('\n').slice(logBefore).some((l) => sids.some((sid) => l.includes(sid))), session_key_present: mine.every((l) => typeof l.session_key === 'string' && l.session_key.length === 12), sample: mine.slice(-2).map((l) => ({ status: l.status, via: l.via, client_impl: l.client_impl, plugin_version: l.plugin_version, injected: l.injected, deduped: l.deduped, duration_ms: l.duration_ms, search_ms: l.search_ms })) };
say(`step3 log: ${JSON.stringify(out.steps.log)}`);
server.kill('SIGTERM'); await new Promise((r) => server.on('exit', r));
out.steps.server.exited = true; out.steps.server.socket_removed = !fs.existsSync(sock); out.steps.server.stderr_tail = serr.trim().split('\n').slice(-3);
out.verdict = { block_nonempty: out.steps.timing.block_nonempty, journey_complete: out.steps.build.srchash_matches && out.steps.server.socket_exists && nat.every((r) => r.status === 0) && node.every((r) => r.status === 0), same_block: out.steps.timing.same_stdout, native_median_le_40ms: out.steps.timing.native_median_ms <= 40, log_marks: out.steps.log.plugin_versions.length === 1 && out.steps.log.plugin_versions[0] === VERSION && (out.steps.log.client_impl.native || 0) >= 5 && (out.steps.log.client_impl.node || 0) >= 5 && out.steps.log.via.every((v) => v === 'daemon'), no_plaintext_session_id: !out.steps.log.session_id_plaintext_in_lines && out.steps.log.session_key_present };
out.verdict.pass = Object.values(out.verdict).every(Boolean);
say(`VERDICT: ${JSON.stringify(out.verdict)}`);
fs.writeFileSync(path.join(REPO, '.qa-artifacts/e2e-live.json'), JSON.stringify(out, null, 2));
process.exit(out.verdict.pass ? 0 : 2);

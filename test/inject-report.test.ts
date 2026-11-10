import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { VARIANTS, codeDigest, judgeMessage, judgeMessageSha, labelItems, parseDecisionsBlock, sqliteDigest } from '../bench/inject-bench-lib.mjs';
import { truncateFact } from '../src/fact-text.js';
import { EMBEDDING_MODEL } from '../src/embedding-version.js';

/**
 * `inject-judge.mjs --report` run end to end on a small synthetic bench folder (plan 2026-10-19):
 * a VALID harness (controls, 30 re-judged prompts, 110 held-out, 30 hard), so the decision itself is
 * asserted — which reading decides C2, what V4 is bound to, and which mismatched inputs stop the report.
 * 220 prompts; the family variant adds one grade-2 line to q0..q19. The registered reading lists
 * q0..q39 (40 prompts — keep), the post-hoc as-of reading q0..q19 (20 — below the minimum of 30).
 * q0..q4 also show a grade-2 line h<i> in both v0 and family (the gain is family minus v0, not family's count).
 * Every judgment row is bound to its judge message (seed + sha256), rebuilt from the snapshot's facts.
 */

// The slowest tests here run the report script as a child process many times each: 10-16s alone,
// 14-23s inside the 83-file suite of v1.7.9, and 31s once inside the 143-file suite (2026-11-11) —
// past the 30s default. Nothing in this file asserts on time, so the file gets a 90s limit.
vi.setConfig({ testTimeout: 90_000 });

const SCRIPT = fileURLToPath(new URL('../bench/inject-judge.mjs', import.meta.url));
const REPO = path.resolve(path.dirname(SCRIPT), '..');
const N = 220;
const HARD = Array.from({ length: 30 }, (_, i) => `q${190 + i}`);
const sha = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
let out: string;

type Line = { id: string; origin: string; note: string; margin: number | null };
const qids = Array.from({ length: N }, (_, i) => `q${i}`);
const projectOf = (i: number) => `/no-such-root/proj-${i % 3}`;
const promptOf = (i: number) => ({ qid: `q${i}`, project: projectOf(i), split: i % 2 ? 'heldout' : 'train', query: `query ${i}`, ts: '2026-10-01T00:00:00Z', sessionId: `s${i}` });
const factText = (id: string) => `note ${id} about the synthetic bench`;
const judged = (id: string) => `[decision] ${truncateFact(factText(id))}`;

function writeLines(variant: string, rows: Array<{ qid: string; lines: Line[] }>) {
  fs.writeFileSync(path.join(out, `lines-${variant}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
function writeMeta(patch: Record<string, unknown> = {}) {
  const hashes = Object.fromEntries(VARIANTS.map((v) => [v, sha(path.join(out, `lines-${v}.jsonl`))]));
  const meta = {
    prompts: N, hard: HARD, kw: { identifiers: 0, picked: 0, bypassSkipped: 0 },
    affectedRegistered: qids.slice(0, 40), affectedAsOf: qids.slice(0, 20),
    hashes, inputs: { sample: sha(path.join(out, 'sample.json')), snapshot: sqliteDigest(path.join(out, 'snapshot.sqlite')) },
    roots: Object.fromEntries([0, 1, 2].map((i) => [projectOf(i), []])),
    code: { git: null, dirty: null, files: codeDigest(REPO, EMBEDDING_MODEL) },
    ...patch,
  };
  fs.writeFileSync(path.join(out, 'replay-meta.json'), JSON.stringify(meta));
  return meta;
}
function writeDeterminism(override: Record<string, { a?: string; b?: string }> = {}) {
  const variants = Object.fromEntries(VARIANTS.map((v) => {
    const h = sha(path.join(out, `lines-${v}.jsonl`));
    return [v, { a: override[v]?.a ?? h, b: override[v]?.b ?? h, lines: h, identical: true }];
  }));
  fs.writeFileSync(path.join(out, 'determinism.json'), JSON.stringify({ identical: true, variants }));
}
/**
 * Run the script without blocking this worker: a test here runs it a dozen times, and a worker whose event loop is
 * held that long misses vitest's RPC deadline. The transcripts it reads are the fixture's (never this machine's own).
 */
function run(args: string[], script = SCRIPT): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, TEST_PROJECTS_DIR: path.join(out, 'projects') } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
async function report(doc?: string, script = SCRIPT) {
  const r = await run(['--report', '--out', out, ...(doc ? ['--doc', doc] : [])], script);
  const file = path.join(out, 'report.json');
  return { status: r.status, stderr: r.stderr, report: r.status === 0 && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null };
}
/**
 * A checkout the report can run from whose embedding model has not been downloaded yet — what a fresh clone is
 * until something first loads the model. bench/ is copied (the script takes its repository from its own path),
 * dist/ and every installed package are links to this checkout's, except @xenova/transformers: a folder of its
 * own that links the package's entries but its download cache and local models folder.
 */
function checkoutWithoutModel(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-report-repo-'));
  fs.cpSync(path.join(REPO, 'bench'), path.join(repo, 'bench'), { recursive: true });
  fs.symlinkSync(path.join(REPO, 'dist'), path.join(repo, 'dist'));
  const linkEntries = (from: string, to: string, own: Record<string, (from: string, to: string) => void> = {}) => {
    fs.mkdirSync(to);
    for (const name of fs.readdirSync(from)) {
      if (own[name]) own[name](path.join(from, name), path.join(to, name));
      else fs.symlinkSync(path.join(from, name), path.join(to, name));
    }
  };
  linkEntries(path.join(REPO, 'node_modules'), path.join(repo, 'node_modules'), {
    '@xenova': (from, to) => linkEntries(from, to, {
      transformers: (pkgFrom, pkgTo) => linkEntries(pkgFrom, pkgTo, { '.cache': () => {}, models: () => {} }),
    }),
  });
  return repo;
}

const shared = (i: number): Line[] => (i < 5 ? [{ id: `h${i}`, origin: 'vec', note: '', margin: 0.2 }] : []);
const base = (i: number): Line[] => (HARD.includes(`q${i}`) ? [] : [{ id: `f${i}`, origin: 'vec', note: '', margin: 0.1 }, ...shared(i)]);
const familyLines = (i: number): Line[] => (i < 20 ? [...base(i), { id: `g${i}`, origin: 'vec', note: '', margin: 0.05 }] : base(i));
const bound = (i: number, items: Array<{ factId: string; kind: string }>, seed: string) => ({ seed, message: judgeMessageSha(promptOf(i), items, seed, judged) });
/** The judge's answer to a row: its items labelled with the seed, each given the row's score. */
const replyFor = (items: Array<{ factId: string; kind: string }>, scores: Record<string, number>, seed: string) =>
  JSON.stringify(labelItems(items.map((it) => ({ ...it, text: judged(it.factId) })), seed).map((it) => ({ id: it.label, score: scores[it.factId] })));
/** A judgment row as the judge writes it: binding and the reply it got. */
const judgedRow = (i: number, pass: string, items: Array<{ factId: string; kind: string }>, scores: Record<string, number>, seed: string) =>
  ({ qid: `q${i}`, pass, model: 'test-model', scores, items, bound: bound(i, items, seed), reply: replyFor(items, scores, seed) });
const NO_DRIFT = {
  unbound: 0, drifted: 0, noReply: 0, noCall: 0, badItems: 0, callReused: 0, transcriptMismatch: 0, keptWithoutRow: 0, malformedRows: 0, failedUnbound: 0,
  duplicateRows: 0, overlapItems: 0, noSelfRecord: 0, notLegacy: 0, retiredLost: 0, answeredByOther: 0, evidenceDrift: false,
};
type Item = { factId: string; kind: string };
/** The isolated LLM sessions' transcript folder of the fixture (one SDK query per file: the message, then the answer). */
const llmDir = () => path.join(out, 'projects', '-private-tmp-memory-bank-llm');
function recordCall(name: string, i: number, items: Item[], scores: Record<string, number>, seed: string, model = 'test-model') {
  const labeled = labelItems(items.map((it) => ({ ...it, text: judged(it.factId) })), seed);
  const reply = JSON.stringify(labeled.map((it) => ({ id: it.label, score: scores[it.factId] })));
  fs.mkdirSync(llmDir(), { recursive: true });
  fs.writeFileSync(path.join(llmDir(), name), [
    JSON.stringify({ type: 'user', message: { role: 'user', content: judgeMessage(promptOf(i), labeled) } }),
    JSON.stringify({ type: 'assistant', message: { model, content: [{ type: 'text', text: reply }] } }),
  ].join('\n') + '\n');
}
const lastJson = (r: { stdout: string }) => JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}');
async function bind() {
  return run(['--bind-legacy', '--out', out]);
}
/** The call --judge keeps right after a row (judge-calls.jsonl, under the row's key — no transcript needed). */
function keepSelf(rowLine: string, i: number, items: Item[], seed: string, reply: string) {
  const key = crypto.createHash('sha256').update(rowLine).digest('hex');
  const labeled = labelItems(items.map((it) => ({ ...it, text: judged(it.factId) })), seed);
  fs.appendFileSync(path.join(out, 'judge-calls.jsonl'), JSON.stringify({ key, file: `self/${key}`, message: judgeMessage(promptOf(i), labeled), reply, model: 'test-model', attempts: 1 }) + '\n');
}
/** Bind every scored row (the fixture's calls are recorded); a run that leaves a row unbound is a fixture error. */
async function rebind() {
  const r = await bind();
  if (r.status !== 0) throw new Error(`--bind-legacy: ${r.stdout}${r.stderr}`);
  return r;
}
const rewrite = (file: string, n: number, change: (row: Record<string, any>) => Record<string, unknown>) => {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  lines[n] = JSON.stringify(change(JSON.parse(lines[n])));
  fs.writeFileSync(file, lines.join('\n') + '\n');
};

async function makeFixture(opts: { withoutControls?: number } = {}) {
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-report-'));
  fs.writeFileSync(path.join(out, 'sample.json'), JSON.stringify(qids.map((_, i) => promptOf(i))));
  const db = new Database(path.join(out, 'snapshot.sqlite'));
  db.exec('CREATE TABLE facts (id TEXT PRIMARY KEY, fact TEXT, category TEXT)');
  const ins = db.prepare("INSERT INTO facts VALUES (?, ?, 'decision')");
  for (let i = 0; i < N; i++) for (const k of ['f', 'g', 'h', 'cs', 'co']) ins.run(`${k}${i}`, factText(`${k}${i}`));
  db.close();
  for (const v of VARIANTS) writeLines(v, qids.map((qid, i) => ({ qid, lines: v === 'family' ? familyLines(i) : base(i) })));
  // Main judgments: every shown line, plus one same-scope and one other-project control per prompt (all 0).
  const rows: string[] = [];
  const scoresOf = (i: number) => ({
    ...(HARD.includes(`q${i}`) ? {} : { [`f${i}`]: 1 }), ...(i < 5 ? { [`h${i}`]: 2 } : {}), ...(i < 20 ? { [`g${i}`]: 2 } : {}), [`cs${i}`]: 0, [`co${i}`]: 0,
  });
  const itemsOf = (i: number) => [
    ...(HARD.includes(`q${i}`) ? [] : [{ factId: `f${i}`, kind: 'line' }]), ...(i < 5 ? [{ factId: `h${i}`, kind: 'line' }] : []),
    ...(i < 20 ? [{ factId: `g${i}`, kind: 'line' }] : []),
    // a prompt judged without controls (no fact to pick one from) — opts.withoutControls
    ...(i === opts.withoutControls ? [] : [{ factId: `cs${i}`, kind: 'control_same' }, { factId: `co${i}`, kind: 'control_other' }]),
  ];
  // q7's first main row was judged before f7 was shown; a fill-in row asked f7 alone later (no controls)
  const firstItems = (i: number) => itemsOf(i).filter((it) => !(i === 7 && it.factId === 'f7'));
  const scoresAsked = (i: number, items = itemsOf(i)) => Object.fromEntries(items.map((it) => [it.factId, scoresOf(i)[it.factId]]));
  const asked: Array<[number, string, Item[], Record<string, number>, string]> = qids.map((qid, i) => [i, 'main', firstItems(i), scoresAsked(i, firstItems(i)), `${qid}:main:0`]);
  asked.push([7, 'main', [{ factId: 'f7', kind: 'line' }], { f7: 1 }, `q7:main:${firstItems(7).length}`]);
  // 30 re-judged prompts, same scores (agreement 1.0, ≥ 100 pairs).
  for (let i = 0; i < 30; i++) asked.push([i, 'rejudge', itemsOf(i), scoresAsked(i), `q${i}:rejudge`]);
  // every call is recorded (fx-<row>.jsonl) and kept by --judge under its row's key, and every row bound to it, as --judge leaves them
  fs.writeFileSync(path.join(out, 'judge-calls.jsonl'), '');
  asked.forEach(([i, pass, items, scores, seed], n) => {
    const row = judgedRow(i, pass, items, scores, seed);
    rows.push(JSON.stringify(row));
    recordCall(`fx-${n}.jsonl`, i, items, scores, seed);
    keepSelf(JSON.stringify(row), i, items, seed, row.reply);
  });
  fs.writeFileSync(path.join(out, 'judgments.jsonl'), rows.join('\n') + '\n');
  writeMeta();
  writeDeterminism();
  await rebind();
}

beforeEach(makeFixture);
afterEach(() => { fs.rmSync(out, { recursive: true, force: true }); });

describe('inject-judge --report (synthetic bench folder, valid harness)', () => {
  it('the registered reading decides C2 (keep) and the committed decisions block says so; the as-of reading decides nothing', async () => {
    const doc = path.join(out, 'doc.md');
    const r = await report(doc);
    expect(r.status, r.stderr).toBe(0);
    expect(r.report.validity.valid, JSON.stringify(r.report.validity.gates)).toBe(true);
    expect(r.report.c2.affected).toBe(40);
    expect(r.report.c2.j2Delta.point).toBeCloseTo(20 / 40, 10);
    expect(r.report.c2.asOf.affected).toBe(20);
    expect(r.report.c2.asOf.decision, 'below the registered minimum').toBe('not-decidable');
    expect(r.report.decisions.C2.decision).toBe('keep');
    expect(r.report.decisions.production).toEqual({ relMargin: null, scopeFamily: true });
    expect(parseDecisionsBlock(fs.readFileSync(doc, 'utf8')), 'the doc block is the report\'s decision').toEqual({ verdict: 'valid', production: { relMargin: null, scopeFamily: true } });
    expect(r.report.c2.byRepo.totalGain, 'family minus v0 — q0..q4 show h<i> in both').toBe(20);
    expect(r.report.c2.byPlacement).toEqual({ 'no-family': { prompts: 40, differs: 20, gain: 20 } });
    // grouped by cwd (no roots): gains 7·7·6 over proj-0·proj-2·proj-1; without the largest, 26 prompts — below 30
    expect(r.report.c2.byRepo.gainByRepo).toEqual([7, 7, 6]);
    expect(r.report.c2.byRepo.largest).toEqual({ prompts: 14, differs: 7, gain: 7, cwdRoots: 1 });
    expect(r.report.c2.byRepo.withoutLargest).toEqual({ measurable: false, n: 26, gain: 13 });
    expect(r.report.c2.blockDiffers).toEqual({ prompts: 20, cwds: 3, repos: 3 });
    expect(r.report.judge.binding).toEqual({
      inline: 251, transcript: 0, retried: 0, transcriptChecked: 251, transcriptGone: 0, staleLines: 0, staleRows: 0,
      selfRecorded: 0, retiredCalls: 0, legacyListed: 0, recordedJudgeCalls: 251, smokeCalls: 0, callsWithoutRow: 0, transcriptsFolder: true,
      ...NO_DRIFT,
    });
    expect(r.report.judge.fillRows, 'the q7 row without controls').toBe(1);
    expect(r.report.judge.promptsWithoutControls, 'q7 also has its first row with controls').toBe(0);
    const docText = fs.readFileSync(doc, 'utf8');
    expect(docText, 'the doc names the report it came from').toContain(`sha256: \`${sha(path.join(out, 'report.json'))}\``);
    expect(docText, 'every placement bucket the report holds is listed').toContain('가족 없음 40·20·+20');
    expect(r.report.inputs.sample).toBe(sha(path.join(out, 'sample.json')));
    expect(r.report.inputs.judgments).toBe(sha(path.join(out, 'judgments.jsonl')));
    const status = execFileSync('git', ['-C', REPO, 'status', '--porcelain', '--', 'src', 'bench', 'dist'], { encoding: 'utf8' }).trim();
    expect(r.report.inputs.code.report.dirty, 'the dirty flag is the working tree\'s').toBe(status !== '');
  });

  it('--bind-legacy binds every scored row to a recorded judge call with its message AND its scores, one call per row; the report checks the kept call again', async () => {
    const file = path.join(out, 'judgments.jsonl');
    const callsFile = path.join(out, 'judge-calls.jsonl');
    const bindingsFile = path.join(out, 'judgment-bindings.json');
    // start over: nothing bound yet, rows 0 and 1 written before rows carried their own binding, their calls not found yet;
    // the other rows as --judge left them (each with the call it kept right after the row)
    fs.rmSync(bindingsFile);
    for (const n of [0, 1]) fs.rmSync(path.join(llmDir(), `fx-${n}.jsonl`));
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const legacy = [0, 1].map((n) => { const row = JSON.parse(lines[n]); lines[n] = JSON.stringify({ ...row, bound: undefined, reply: undefined }); return row; });
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const selfLines = fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).filter((l) => JSON.parse(l).file.startsWith('self/'));
    const legacyKeys = new Set(legacy.map((row) => crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex')));
    fs.writeFileSync(callsFile, selfLines.filter((l) => !legacyKeys.has(JSON.parse(l).key)).join('\n') + '\n');
    const none = await report();
    expect(none.stderr, 'no binding anywhere (and no list of rows written before bindings yet)').toMatch(/249 without a binding/);
    expect(none.stderr).toMatch(/2 rows without their own binding that the first --bind-legacy did not list/);
    const record = (name: string, n: number, scores = legacy[n].scores, model = 'test-model') => recordCall(name, n, legacy[n].items, scores, legacy[n].bound.seed, model);
    record('row0.jsonl', 0);
    record('row1-other-model.jsonl', 1, legacy[1].scores, 'another-model');
    record('row1-other-scores.jsonl', 1, { ...legacy[1].scores, cs1: 2 });
    const first = await bind();
    expect(first.status, 'row 1 has no call with its model and its scores').toBe(1);
    expect(lastJson(first)).toMatchObject({ withOwnBinding: 249, matched: 250, unmatchedScored: 1 });
    expect((await report()).stderr).toMatch(/1 without a binding/);
    record('row1.jsonl', 1);
    const second = await bind();
    expect(second.status, second.stderr).toBe(0);
    expect(lastJson(second)).toMatchObject({ kept: 250, matched: 1, unmatchedScored: 0 });
    const r = await report();
    expect(r.status, r.stderr).toBe(0);
    expect(r.report.judge.binding).toMatchObject({ inline: 249, transcript: 2, transcriptChecked: 251, transcriptGone: 0, ...NO_DRIFT });
    expect(r.report.inputs.bindings).toBe(sha(bindingsFile));
    expect(r.report.inputs.judgeCalls).toBe(sha(callsFile));
    const kept = fs.readFileSync(callsFile, 'utf8');
    const keptBindings = fs.readFileSync(bindingsFile, 'utf8');
    const keptLines = kept.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const shaOf = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
    const restore = () => { fs.writeFileSync(callsFile, kept); fs.writeFileSync(bindingsFile, keptBindings); };
    /** Rewrite the kept call of row 0 (and, for a consistent forgery, its binding and the evidence hash to match). */
    const forge = (call: Record<string, any>, consistent: boolean) => {
      const body = [call, ...keptLines.slice(1)].map((l) => JSON.stringify(l)).join('\n') + '\n';
      fs.writeFileSync(callsFile, body);
      if (!consistent) return;
      const doc = JSON.parse(keptBindings);
      const b = doc.rows[keptLines[0].key];
      b.call.messageSha = shaOf(call.message);
      b.call.replySha = shaOf(call.reply);
      b.call.model = call.model;
      b.call.file = call.file;
      doc.evidence.sha256 = shaOf(body);
      fs.writeFileSync(bindingsFile, JSON.stringify(doc));
    };
    const otherScore = (reply: string) => JSON.stringify(JSON.parse(reply).map((x: { id: string; score: number }, n: number) => (n === 0 ? { ...x, score: (x.score + 1) % 3 } : x)));
    const NOT_KEPT = /1 whose kept judge call is missing or does not give the row's scores/;
    forge({ ...keptLines[0], reply: otherScore(keptLines[0].reply) }, false);
    expect((await report()).stderr, 'the reply bytes differ from the ones bound — and the kept file from the one named').toMatch(/1 whose kept judge call is missing or does not give the row's scores, 0 whose score keys .*and judge-calls\.jsonl is not the file the bindings name/);
    forge({ ...keptLines[0], reply: otherScore(keptLines[0].reply) }, true);
    expect((await report()).stderr, 'a consistent forgery of the reply: its scores still differ from the row').toMatch(NOT_KEPT);
    forge({ ...keptLines[0], message: `${keptLines[0].message} (and one more thing)` }, true);
    expect((await report()).stderr, 'a consistent forgery of the message: not the message the row was judged on').toMatch(NOT_KEPT);
    forge({ ...keptLines[0], model: 'another-model' }, true);
    expect((await report()).stderr, 'another model answered').toMatch(NOT_KEPT);
    restore();   // the binding names the true call again: only the kept call's file name differs below
    forge({ ...keptLines[0], file: `${keptLines[0].file}.elsewhere` }, false);
    expect((await report()).stderr, 'the kept call is not the recording the binding names').toMatch(NOT_KEPT);
    forge({ ...keptLines[0], file: keptLines[1].file }, true);
    expect((await report()).stderr, 'one recorded call named as the answer to two rows').toMatch(/1 binding a call another row binds/);
    restore();
    fs.appendFileSync(callsFile, '\n');
    expect((await report()).stderr, 'the kept file is not the one the bindings name').toMatch(/judge-calls\.jsonl is not the file the bindings name/);
    restore();
    // the original transcript, while it is there, is checked against the kept call
    const row0 = path.join(llmDir(), 'row0.jsonl');
    const original = fs.readFileSync(row0, 'utf8');
    expect(original).toContain('"model":"test-model"');
    fs.writeFileSync(row0, original.replace('"model":"test-model"', '"model":"another-model"'));
    expect((await report()).stderr, 'the transcript now says something else').toMatch(/1 whose transcript differs from the kept call/);
    fs.writeFileSync(row0, original);
    // transcripts expire: once they are gone, --bind-legacy keeps the bindings whose kept calls still hold
    for (const f of fs.readdirSync(llmDir())) fs.rmSync(path.join(llmDir(), f));
    const third = await bind();
    expect(third.status, third.stderr).toBe(0);
    expect(lastJson(third)).toMatchObject({ transcripts: 0, keptOnly: 500, kept: 251, matched: 0, unmatchedScored: 0, keptUnbound: 249, keptWithoutRow: 0 });
    expect(fs.readFileSync(callsFile, 'utf8'), 'the kept calls are the same bytes').toBe(kept);
    const gone = await report();
    expect(gone.status, gone.stderr).toBe(0);
    expect(gone.report.judge.binding).toMatchObject({ inline: 249, transcript: 2, transcriptChecked: 0, transcriptGone: 251, recordedJudgeCalls: 0, legacyListed: 2, ...NO_DRIFT });
    // with the bindings file gone too, the kept calls alone bind every row again (they are the only copy now)
    fs.rmSync(bindingsFile);
    const fourth = await bind();
    expect(fourth.status, fourth.stderr).toBe(0);
    expect(lastJson(fourth)).toMatchObject({ kept: 0, matched: 251, unmatchedScored: 0 });
    expect(fs.readFileSync(callsFile, 'utf8'), 'nothing lost').toBe(kept);
    expect((await report()).status).toBe(0);
    // the same row twice (an append repeated): its kept call answers one of them, the other stays unbound
    const judgedLines = fs.readFileSync(file, 'utf8');
    fs.appendFileSync(file, judgedLines.split('\n')[0] + '\n');
    const dup = await bind();
    expect(dup.status, 'a duplicated row cannot take its call a second time').toBe(1);
    expect(lastJson(dup)).toMatchObject({ kept: 251, duplicateRows: 1 });
    expect(fs.readFileSync(callsFile, 'utf8')).toBe(kept);
    expect((await report()).stderr).toMatch(/1 duplicated rows/);
    // a copy of a row written before bindings (another kind for a control): not in the list the first --bind-legacy made
    fs.writeFileSync(file, judgedLines + JSON.stringify({ ...JSON.parse(judgedLines.split('\n')[0]), items: JSON.parse(judgedLines.split('\n')[0]).items.map((it: Item) => (it.kind === 'control_other' ? { ...it, kind: 'control_same' } : it)) }) + '\n');
    const copy = await bind();
    expect(copy.status).toBe(1);
    expect(lastJson(copy)).toMatchObject({ notLegacy: 1 });
    expect((await report()).stderr).toMatch(/1 rows without their own binding that the first --bind-legacy did not list/);
    // a row of a prompt no longer sampled is the report's to ignore, not a row left unbound
    fs.writeFileSync(file, judgedLines + JSON.stringify({ qid: 'q-gone', pass: 'main', model: 'test-model', items: [{ factId: 'f0', kind: 'line' }], scores: { f0: 1 } }) + '\n');
    const outside = await bind();
    expect(outside.status, outside.stderr).toBe(0);
    expect(lastJson(outside)).toMatchObject({ outOfSample: 1, unmatchedScored: 0 });
    // a row that can no longer be bound: the run fails, and every kept call stays in the file
    fs.writeFileSync(file, judgedLines);
    rewrite(file, 2, (row) => ({ ...row, bound: undefined, reply: undefined, scores: { ...row.scores, cs2: 2 } }));
    const fifth = await bind();
    expect(fifth.status).toBe(1);
    expect(lastJson(fifth)).toMatchObject({ unmatchedScored: 1, notLegacy: 1, keptWithoutRow: 2 });
    const after = fs.readFileSync(callsFile, 'utf8');
    for (const l of kept.split('\n').filter(Boolean)) expect(after).toContain(l);
    fs.rmSync(callsFile);
    expect((await report()).stderr, 'a bindings file without its calls').toMatch(/0 without a binding, 0 whose message no longer matches .*250 whose kept judge call is missing.*1 rows without their own binding that the first --bind-legacy did not list/);
  });

  it('a row the judge wrote must carry the reply that gives its scores and items that are its score keys; no control is a line shown now', async () => {
    const cases: Array<[string, (row: Record<string, any>) => Record<string, unknown>, RegExp]> = [
      // a legacy row given an inline binding by hand: no reply behind it
      ['inline binding without a reply', (row) => ({ ...row, reply: undefined }), /1 judged rows without the reply that gives their scores/],
      ['reply with other scores', (row) => ({ ...row, reply: replyFor(row.items, { ...row.scores, cs3: 2 }, row.bound.seed) }), /1 judged rows without the reply/],
      ['scores changed, reply kept', (row) => ({ ...row, scores: { ...row.scores, cs3: 2 } }), /1 judged rows without the reply/],
      // the judgment file alone made consistent (scores, reply and binding agree): no recorded call gives these scores
      ['scores and reply changed together', (row) => ({ ...row, scores: { ...row.scores, cs3: 2 }, reply: replyFor(row.items, { ...row.scores, cs3: 2 }, row.bound.seed) }), /1 without a binding, 0 whose message/],
      ['a score key outside the items', (row) => ({ ...row, scores: { ...row.scores, g99: 2 } }), /1 whose score keys are not their items or whose controls are lines shown now/],
      ['an item without a score', (row) => {
        const { cs3: _cs3, ...scores } = row.scores;
        return { ...row, scores, reply: replyFor(row.items, { ...scores, cs3: 0 }, row.bound.seed) };
      }, /1 whose score keys are not their items/],
      ['a shown line relabelled as a control', (row) => {
        const items = row.items.map((it: { factId: string; kind: string }) => (it.factId === 'f3' ? { ...it, kind: 'control_same' } : it));
        return { ...row, items, bound: bound(3, items, row.bound.seed), reply: replyFor(items, row.scores, row.bound.seed) };
      }, /1 whose score keys are not their items or whose controls are lines shown now/],
    ];
    for (const [name, change, message] of cases) {
      fs.rmSync(out, { recursive: true, force: true });
      await makeFixture();
      expect((await report()).status, `${name}: positive control on a fresh folder`).toBe(0);
      rewrite(path.join(out, 'judgments.jsonl'), 3, change);
      const r = await report();
      expect(r.status, name).toBe(1);
      expect(r.stderr, name).toMatch(message);
    }
  });

  it('a line no variant shows now (judged for an earlier replay) is counted and named in the doc, never read as a line', async () => {
    // judgments are cached per prompt and fact: a replay that no longer shows f3 for q3 leaves its judgment in place
    for (const v of VARIANTS) writeLines(v, qids.map((qid, i) => ({ qid, lines: (v === 'family' ? familyLines(i) : base(i)).filter((l) => !(i === 3 && l.id === 'f3')) })));
    writeMeta();
    writeDeterminism();
    const doc = path.join(out, 'doc.md');
    const r = await report(doc);
    expect(r.status, r.stderr).toBe(0);
    expect(r.report.judge.binding, 'q3\'s main and re-judge rows').toMatchObject({ staleLines: 2, staleRows: 2, ...NO_DRIFT });
    expect(fs.readFileSync(doc, 'utf8')).toContain('지금 어느 변형도 표시하지 않는 줄 항목 2개(2행)');
  });

  it('judgments.jsonl is append-only: relabelling a control in it stops the report even after --bind-legacy re-binds the row', async () => {
    // the judge never sees an item's kind, so the same call binds the edited row — the kept call of the old row is left over
    const file = path.join(out, 'judgments.jsonl');
    rewrite(file, 3, (row) => {
      const items = row.items.map((it: Item) => (it.factId === 'co3' ? { ...it, kind: 'control_same' } : it));
      return { ...row, items, bound: bound(3, items, row.bound.seed), reply: replyFor(items, row.scores, row.bound.seed) };
    });
    const r = await bind();
    expect(r.status, 'the edited row has no call kept for it; the calls of the old row name no row').toBe(1);
    expect(lastJson(r)).toMatchObject({ unmatchedScored: 1, noSelfRecord: 1, keptWithoutRow: 2 });
    expect((await report()).stderr).toMatch(/2 kept calls of rows no longer in judgments\.jsonl/);
  });

  it('an interrupted append: a torn last line is cut before anything is appended after it, in both files', async () => {
    const file = path.join(out, 'judgments.jsonl');
    const callsFile = path.join(out, 'judge-calls.jsonl');
    const before = fs.readFileSync(file, 'utf8');
    fs.appendFileSync(file, '{"qid":"q3","pass":"main","mod');
    const torn = await report();
    expect(torn.status, torn.stderr).toBe(0);
    expect(torn.report.judge.tornTail).toBe(1);
    fs.appendFileSync(callsFile, '{"key":"abc","fi');
    expect((await report()).stderr, 'a torn kept call is read as such').toMatch(/judge-calls\.jsonl: line 503 is not JSON — run --bind-legacy/);
    const b = await bind();
    expect(b.status, b.stdout + b.stderr).toBe(0);
    expect(lastJson(b)).toMatchObject({ tornCut: 2 });
    expect(fs.readFileSync(file, 'utf8'), 'the torn row is gone, nothing else').toBe(before);
    const r = await report();
    expect(r.status, r.stderr).toBe(0);
    expect(r.report.judge.tornTail).toBe(0);
    // a complete last line that only lost its newline is kept, and gets one
    const lines = before.split('\n').filter(Boolean);
    fs.writeFileSync(file, lines.join('\n'));
    const c = await bind();
    expect(c.status, c.stdout + c.stderr).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('a copy of a judged row appended next to a spare real call of the same message binds nothing: no call was kept for it', async () => {
    // a spare call: the same message asked twice (an interrupted --judge asked again, or another --out folder the same day)
    const file = path.join(out, 'judgments.jsonl');
    const row = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[3]);
    recordCall('spare.jsonl', 3, row.items, row.scores, row.bound.seed);
    const copy = { ...row, items: row.items.map((it: Item) => (it.kind === 'control_other' ? { ...it, kind: 'control_same' } : it)) };
    fs.appendFileSync(file, JSON.stringify(copy) + '\n');
    const b = await bind();
    expect(b.status).toBe(1);
    expect(lastJson(b)).toMatchObject({ noSelfRecord: 1, unmatchedScored: 1 });
    const r = await report();
    expect(r.stderr, 'it would also judge q3\'s facts twice').toMatch(/5 facts judged twice in one prompt's main rows/);
  });

  it('a rebuilt snapshot: --retire-stale retires the rows judged on other text (their kept calls marked, never dropped), then binds', async () => {
    const callsFile = path.join(out, 'judge-calls.jsonl');
    const before = fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).length;
    const db = new Database(path.join(out, 'snapshot.sqlite'));
    db.prepare("UPDATE facts SET fact = 'rewritten by a later consolidation' WHERE id = 'cs5'").run();
    db.close();
    writeMeta();
    expect((await report()).stderr, 'q5\'s main and re-judge rows were judged on other text').toMatch(/2 whose message no longer matches/);
    const r = await run(['--retire-stale', '--out', out]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(JSON.parse(r.stdout.trim().split('\n')[0])).toEqual({ retired: 2 });
    expect(lastJson(r)).toMatchObject({ rows: 249, keptWithoutRow: 0, unmatchedScored: 0 });
    const calls = fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(calls.length, 'every kept call stays').toBe(before);
    expect(calls.filter((c) => c.retired).length, 'the 2 rows\' transcript calls and the 2 --judge kept').toBe(4);
    // what is left to do is asking q5 again (--judge) — the report says so, and no longer stops on the retired rows
    const after = await report();
    expect(after.stderr).toMatch(/1 prompt\(s\) have shown lines without a judgment/);
      // a retired call is recorded by the bindings: removing it from judge-calls.jsonl (and binding again) stops every run
    const kept = fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean);
    const firstRetired = kept.findIndex((l) => JSON.parse(l).retired);
    fs.writeFileSync(callsFile, kept.filter((_, n) => n !== firstRetired).join('\n') + '\n');
    const lost = await bind();
    expect(lost.status, 'retiring and asking again would leave no trace').toBe(1);
    expect(lastJson(lost)).toMatchObject({ retiredLost: 1 });
    expect((await bind()).status, 'and it stays lost on the next run').toBe(1);
    expect((await report()).stderr).toMatch(/1 retired calls the bindings recorded that are gone from judge-calls\.jsonl/);
  });

  it('retiring: a row whose control is a line shown now goes too; a failed row never does (V6 counts it for good)', async () => {
    const file = path.join(out, 'judgments.jsonl');
    // a failed row of q5 as --judge leaves it (the row, then its failed call), judged on cs5's text of then
    const failedItems = [{ factId: 'cs5', kind: 'line' }];
    const failedLine = JSON.stringify({ qid: 'q5', pass: 'main', model: 'test-model', at: '2026-10-19T00:00:00Z', items: failedItems, bound: bound(5, failedItems, 'q5:main:99'), failed: 'invalid reply' });
    fs.appendFileSync(file, failedLine + '\n');
    keepSelf(failedLine, 5, failedItems, 'q5:main:99', 'not json');
    await rebind();
    // cs5 rewritten (q5's main and re-judge rows were judged on other text), and cs6 — a control of q6's two rows — now shown
    const db = new Database(path.join(out, 'snapshot.sqlite'));
    db.prepare("UPDATE facts SET fact = 'rewritten by a later consolidation' WHERE id = 'cs5'").run();
    db.close();
    for (const v of VARIANTS) writeLines(v, qids.map((qid, i) => ({ qid, lines: [...(v === 'family' ? familyLines(i) : base(i)), ...(i === 6 ? [{ id: 'cs6', origin: 'vec', note: '', margin: 0 }] : [])] })));
    writeMeta();
    writeDeterminism();
    const r = await run(['--retire-stale', '--out', out]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(JSON.parse(r.stdout.trim().split('\n')[0]), 'q5\'s two rows and q6\'s two — not the failed one').toEqual({ retired: 4 });
    expect(fs.readFileSync(file, 'utf8').split('\n'), 'the failed row stays').toContain(failedLine);
    expect(lastJson(r)).toMatchObject({ failedRows: 1, failedWithoutCall: 0, keptWithoutRow: 0, unmatchedScored: 0 });
  });

  it('retiring cut off after marking the calls: the rows are still there and still stale, so the next run finishes it', async () => {
    const file = path.join(out, 'judgments.jsonl');
    const callsFile = path.join(out, 'judge-calls.jsonl');
    const db = new Database(path.join(out, 'snapshot.sqlite'));
    db.prepare("UPDATE facts SET fact = 'rewritten by a later consolidation' WHERE id = 'cs5'").run();
    db.close();
    writeMeta();
    // what a run cut off after its first two writes leaves: the bindings name q5's rows and marked calls, the calls are
    // marked, q5's rows are still in judgments.jsonl
    const keys5 = new Set(fs.readFileSync(file, 'utf8').split('\n').filter((l) => l && JSON.parse(l).qid === 'q5').map((l) => crypto.createHash('sha256').update(l).digest('hex')));
    expect(keys5.size).toBe(2);
    const mark = '2026-10-19T00:00:00.000Z';
    const marked = fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((l) => { const c = JSON.parse(l); return keys5.has(c.key) ? { ...c, retired: mark } : c; });
    fs.writeFileSync(callsFile, marked.map((c) => JSON.stringify(c)).join('\n') + '\n');
    const bindingsFile = path.join(out, 'judgment-bindings.json');
    const doc = JSON.parse(fs.readFileSync(bindingsFile, 'utf8'));
    const entries = marked.filter((c) => c.retired).map((c) => ({ sha: crypto.createHash('sha256').update(JSON.stringify(c)).digest('hex'), key: c.key, file: c.file }));
    fs.writeFileSync(bindingsFile, JSON.stringify({ ...doc, retired: entries, retiredRows: [...keys5] }));
    const r = await run(['--retire-stale', '--out', out]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(JSON.parse(r.stdout.trim().split('\n')[0])).toEqual({ retired: 2 });
    expect(lastJson(r)).toMatchObject({ rows: 249, keptWithoutRow: 0, unmatchedScored: 0 });
    const calls = fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(calls.filter((c) => c.retired).map((c) => c.retired), 'a mark already set is kept').toEqual([mark, mark, mark, mark]);
  });

  it('a call with no transcript (the API-key path) binds by the call --judge kept for it', async () => {
    const file = path.join(out, 'judgments.jsonl');
    const line5 = fs.readFileSync(file, 'utf8').split('\n')[5];
    const row = JSON.parse(line5);
    const key5 = crypto.createHash('sha256').update(line5).digest('hex');
    // no transcript: only the call --judge kept for itself
    fs.rmSync(path.join(llmDir(), 'fx-5.jsonl'));
    const callsFile = path.join(out, 'judge-calls.jsonl');
    fs.writeFileSync(callsFile, fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).filter((l) => { const c = JSON.parse(l); return c.key !== key5 || c.file === `self/${key5}`; }).join('\n') + '\n');
    fs.rmSync(path.join(out, 'judgment-bindings.json'));
    const b = await bind();
    expect(b.status, b.stdout + b.stderr).toBe(0);
    const r = await report();
    expect(r.status, r.stderr).toBe(0);
    expect(r.report.judge.binding).toMatchObject({ inline: 251, selfRecorded: 1, transcriptChecked: 250, ...NO_DRIFT });
    // a transcript of that same call naming another model: another model answered (the refusal fallback) — not this row's judge
    fs.rmSync(path.join(out, 'judgment-bindings.json'));
    fs.writeFileSync(callsFile, fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).filter((l) => !JSON.parse(l).file.startsWith('-private')).join('\n') + '\n');
    recordCall('fallback.jsonl', 5, row.items, row.scores, row.bound.seed, 'fallback-model');
    const other = await bind();
    expect(other.status).toBe(1);
    expect(lastJson(other)).toMatchObject({ answeredByOther: 1 });
    });

  it('another model\'s transcript of the same bytes is the row\'s call only if it was answered right before the row was written', async () => {
    const file = path.join(out, 'judgments.jsonl');
    const callsFile = path.join(out, 'judge-calls.jsonl');
    // a row --judge wrote at a known time over the API-key path (no transcript): the row, then its call
    const items = [{ factId: 'f9', kind: 'line' }];
    const reply = replyFor(items, { f9: 1 }, 'q9:main:50');
    const at = '2026-10-19T10:00:00.000Z';
    const line = JSON.stringify({ ...judgedRow(9, 'main', items, { f9: 1 }, 'q9:main:50'), at });
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const transcriptAt = (name: string, when: string, model: string) => {
      const labeled = labelItems(items.map((it) => ({ ...it, text: judged(it.factId) })), 'q9:main:50');
      fs.writeFileSync(path.join(llmDir(), name), [
        JSON.stringify({ type: 'user', timestamp: when, message: { role: 'user', content: judgeMessage(promptOf(9), labeled) } }),
        JSON.stringify({ type: 'assistant', timestamp: when, message: { model, content: [{ type: 'text', text: reply }] } }),
      ].join('\n') + '\n');
    };
    const bindWith = async (when: string) => {
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + line + '\n');
      keepSelf(line, 9, items, 'q9:main:50', reply);
      transcriptAt('other-run.jsonl', when, 'fallback-model');
      return bind();
    };
    // another run's answer of the same bytes, an hour earlier: another call — the row binds by its own record
    const hourBefore = await bindWith('2026-10-19T09:00:00.000Z');
    expect(lastJson(hourBefore), hourBefore.stdout + hourBefore.stderr).toMatchObject({ answeredByOther: 0, unmatchedScored: 0 });
    // the same, answered seconds before the row was written: this row's call, answered by another model — refused
    fs.writeFileSync(file, lines.join('\n') + '\n');
    fs.writeFileSync(callsFile, fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).filter((l) => JSON.parse(l).key !== crypto.createHash('sha256').update(line).digest('hex')).join('\n') + '\n');
    fs.rmSync(path.join(out, 'judgment-bindings.json'));
    const secondsBefore = await bindWith('2026-10-19T09:59:57.000Z');
    expect(secondsBefore.status).toBe(1);
    expect(lastJson(secondsBefore)).toMatchObject({ answeredByOther: 1, unmatchedScored: 1 });
    // the refusal is recorded: once the transcript that showed it is gone (24 hours), the row stays refused
    fs.rmSync(path.join(llmDir(), 'other-run.jsonl'));
    const later = await bind();
    expect(later.status, 'a refused row is not bound by its own record a day later').toBe(1);
    expect(lastJson(later)).toMatchObject({ answeredByOther: 1 });
    expect((await report()).stderr).toMatch(/1 rows another model answered/);
    // and --judge (here --retire-stale) retires it with its prompt's other scored rows, to be asked again
    const r = await run(['--retire-stale', '--out', out]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(JSON.parse(r.stdout.trim().split('\n')[0]), 'the refused row, q9\'s main row and its re-judge').toEqual({ retired: 3 });
    expect(lastJson(r)).toMatchObject({ answeredByOther: 0, unmatchedScored: 0 });
    expect(JSON.parse(fs.readFileSync(path.join(out, 'judgment-bindings.json'), 'utf8')).refused, 'recorded with its prompt (V6 counts it)').toEqual([{ key: crypto.createHash('sha256').update(line).digest('hex'), qid: 'q9' }]);
    // the refused row written back (its original bytes): it goes again on its own — it retires nothing else
    fs.appendFileSync(file, line + '\n');
    const back = await run(['--retire-stale', '--out', out]);
    expect(JSON.parse(back.stdout.trim().split('\n')[0])).toEqual({ retired: 1 });
    // q9's re-judge asked again with the same bytes (the seeds are fixed) and answered by the other model again: the
    // retired call and its transcript are no candidates, so the new row binds only by its own record — refused again
    const rejudge = JSON.parse(lines.find((l) => JSON.parse(l).qid === 'q9' && JSON.parse(l).pass === 'rejudge') as string);
    const again = JSON.stringify({ ...rejudge, at: '2026-10-20T10:00:00.000Z' });
    fs.appendFileSync(file, again + '\n');
    keepSelf(again, 9, rejudge.items, rejudge.bound.seed, rejudge.reply);
    const relabeled = labelItems(rejudge.items.map((it: Item) => ({ ...it, text: judged(it.factId) })), rejudge.bound.seed);
    fs.writeFileSync(path.join(llmDir(), 'again.jsonl'), [
      JSON.stringify({ type: 'user', timestamp: '2026-10-20T09:59:58.000Z', message: { role: 'user', content: judgeMessage(promptOf(9), relabeled) } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-10-20T09:59:58.000Z', message: { model: 'fallback-model', content: [{ type: 'text', text: rejudge.reply }] } }),
    ].join('\n') + '\n');
    const reasked = await bind();
    expect(reasked.status).toBe(1);
    expect(lastJson(reasked), 'not bound to the retired re-judge call of the same bytes').toMatchObject({ answeredByOther: 1, matched: 0 });
    // the refused main row asked again a day later, the other model answering the same scores in other bytes: the
    // retired call kept for the old row (its own record — same message, the requested model's label) is no candidate,
    // so the new row binds by its own record only, and that one is refused
    const old = JSON.parse(line);
    const otherBytes = JSON.stringify(JSON.parse(old.reply), null, 1);
    const later2 = JSON.stringify({ ...old, at: '2026-10-21T10:00:00.000Z', reply: otherBytes });
    fs.appendFileSync(file, later2 + '\n');
    keepSelf(later2, 9, items, 'q9:main:50', otherBytes);
    const labeled9 = labelItems(items.map((it) => ({ ...it, text: judged(it.factId) })), 'q9:main:50');
    fs.writeFileSync(path.join(llmDir(), 'later.jsonl'), [
      JSON.stringify({ type: 'user', timestamp: '2026-10-21T09:59:58.000Z', message: { role: 'user', content: judgeMessage(promptOf(9), labeled9) } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-10-21T09:59:58.000Z', message: { model: 'fallback-model', content: [{ type: 'text', text: otherBytes }] } }),
    ].join('\n') + '\n');
    const dayLater = await bind();
    expect(dayLater.status).toBe(1);
    expect(lastJson(dayLater), 'neither re-asked row binds to a retired call').toMatchObject({ answeredByOther: 2, matched: 0 });
  });

  it('V6 counts every refusal the bindings recorded for a sampled prompt as a failed call, its row retired or not', async () => {
    const bindingsFile = path.join(out, 'judgment-bindings.json');
    const doc = JSON.parse(fs.readFileSync(bindingsFile, 'utf8'));
    fs.writeFileSync(bindingsFile, JSON.stringify({ ...doc, refused: [{ key: 'a-retired-row', qid: 'q3' }, { key: 'another-retired-row', qid: 'q-not-sampled' }] }));
    const r = await report();
    expect(r.status, r.stderr).toBe(0);
    expect(r.report.judge, 'one call more (its row is gone), one failure').toMatchObject({ calls: 252, failures: 1 });
  });

  it('a row written into judgments.jsonl by hand retires nothing: the report stops on it, and its prompt\'s real rows stay', async () => {
    const file = path.join(out, 'judgments.jsonl');
    // a made-up main row of q5 whose "control" g5 is a line shown now — were it a retiring cause, q5's real rows would go
    const madeUp = JSON.stringify({ qid: 'q5', pass: 'main', model: 'test-model', scores: { g5: 2 }, items: [{ factId: 'g5', kind: 'control_same' }] });
    fs.appendFileSync(file, madeUp + '\n');
    const before = fs.readFileSync(file, 'utf8');
    const r = await run(['--retire-stale', '--out', out]);
    expect(JSON.parse(r.stdout.trim().split('\n')[0])).toEqual({ retired: 0 });
    expect(r.status, 'the made-up row binds nothing').toBe(1);
    expect(fs.readFileSync(file, 'utf8'), 'nothing was taken out').toBe(before);
    expect((await report()).stderr).toMatch(/whose controls are lines shown now/);
  });

  it('rows written before bindings: --bind-legacy keeps a binding judged on other text, so the row is still retired whichever runs first', async () => {
    const file = path.join(out, 'judgments.jsonl');
    const callsFile = path.join(out, 'judge-calls.jsonl');
    const bindingsFile = path.join(out, 'judgment-bindings.json');
    // q5's two rows as rows written before rows carried a binding: no `bound`, no reply, no self-record — bound by their transcripts
    const oldKeys = new Set<string>();
    const stripped = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
      const row = JSON.parse(l);
      if (row.qid !== 'q5') return l;
      oldKeys.add(crypto.createHash('sha256').update(l).digest('hex'));
      return JSON.stringify({ ...row, bound: undefined, reply: undefined });
    });
    fs.writeFileSync(file, stripped.join('\n') + '\n');
    fs.writeFileSync(callsFile, fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).filter((l) => !oldKeys.has(JSON.parse(l).key)).join('\n') + '\n');
    fs.rmSync(bindingsFile);
    const first = await bind();
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(bindingsFile, 'utf8')).legacyRows).toHaveLength(2);
    // the snapshot is rebuilt with cs5 rewritten, and --bind-legacy runs first (the report's stop message offers it)
    const db = new Database(path.join(out, 'snapshot.sqlite'));
    db.prepare("UPDATE facts SET fact = 'rewritten by a later consolidation' WHERE id = 'cs5'").run();
    db.close();
    writeMeta();
    const before = await bind();
    expect(before.status, 'judged on other text: not a binding a report can read').toBe(1);
    expect(lastJson(before)).toMatchObject({ drifted: 2, unmatchedScored: 0 });
    expect((await report()).stderr).toMatch(/2 whose message no longer matches/);
    const r = await run(['--retire-stale', '--out', out]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(JSON.parse(r.stdout.trim().split('\n')[0])).toEqual({ retired: 2 });
    expect(lastJson(r)).toMatchObject({ drifted: 0, keptWithoutRow: 0, unmatchedScored: 0 });
  });

  it('a retired main row takes its prompt\'s other scored rows with it — the fill-in row too, so the prompt is asked again with its controls', async () => {
    const file = path.join(out, 'judgments.jsonl');
    const db = new Database(path.join(out, 'snapshot.sqlite'));
    db.prepare("UPDATE facts SET fact = 'rewritten by a later consolidation' WHERE id = 'cs7'").run();
    db.close();
    writeMeta();
    const r = await run(['--retire-stale', '--out', out]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(JSON.parse(r.stdout.trim().split('\n')[0]), 'q7\'s first main row, its fill-in row (f7 alone) and its re-judge').toEqual({ retired: 3 });
    expect(fs.readFileSync(file, 'utf8').split('\n').filter((l) => l && JSON.parse(l).qid === 'q7')).toEqual([]);
  });

  it('retiring cut off after recording in the bindings — and the snapshot put back since: the next run still takes the recorded rows out and writes the same marks', async () => {
    const file = path.join(out, 'judgments.jsonl');
    const callsFile = path.join(out, 'judge-calls.jsonl');
    const bindingsFile = path.join(out, 'judgment-bindings.json');
    const db = new Database(path.join(out, 'snapshot.sqlite'));
    db.prepare("UPDATE facts SET fact = 'rewritten by a later consolidation' WHERE id = 'cs5'").run();
    db.close();
    writeMeta();
    const keys5 = new Set(fs.readFileSync(file, 'utf8').split('\n').filter((l) => l && JSON.parse(l).qid === 'q5').map((l) => crypto.createHash('sha256').update(l).digest('hex')));
    const marked = fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => keys5.has(c.key)).map((c) => JSON.stringify({ ...c, retired: true }));
    expect(marked).toHaveLength(4);
    const doc = JSON.parse(fs.readFileSync(bindingsFile, 'utf8'));
    const entries = marked.map((l) => ({ sha: crypto.createHash('sha256').update(l).digest('hex'), key: JSON.parse(l).key, file: JSON.parse(l).file }));
    fs.writeFileSync(bindingsFile, JSON.stringify({ ...doc, retired: entries, retiredRows: [...keys5] }));
    expect((await report()).stderr, 'recorded, not yet written').toMatch(/4 retired calls the bindings recorded that are gone from judge-calls\.jsonl/);
    // the snapshot put back: q5's rows are no longer stale, yet the recorded retiring is finished
    const back = new Database(path.join(out, 'snapshot.sqlite'));
    back.prepare("UPDATE facts SET fact = ? WHERE id = 'cs5'").run(factText('cs5'));
    back.close();
    writeMeta();
    const r = await run(['--retire-stale', '--out', out]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(JSON.parse(r.stdout.trim().split('\n')[0])).toEqual({ retired: 2 });
    expect(lastJson(r)).toMatchObject({ retiredLost: 0, keptWithoutRow: 0, unmatchedScored: 0 });
  });

  it('a row the judge wrote is bound with its own seed and message: another seed\'s call, or a call on other text, binds nothing', async () => {
    const file = path.join(out, 'judgments.jsonl');
    const callsFile = path.join(out, 'judge-calls.jsonl');
    const bindingsFile = path.join(out, 'judgment-bindings.json');
    const shaOf = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
    const line3 = fs.readFileSync(file, 'utf8').split('\n')[3];
    const row = JSON.parse(line3);
    const key = shaOf(line3);
    // the bindings and kept calls rewritten together to a call of another seed (same items, same scores)
    const seed = 'q3:main:1';
    recordCall('other-seed.jsonl', 3, row.items, row.scores, seed);
    const message = judgeMessage(promptOf(3), labelItems(row.items.map((it: Item) => ({ ...it, text: judged(it.factId) })), seed));
    const reply = replyFor(row.items, row.scores, seed);
    const callFile = '-private-tmp-memory-bank-llm/other-seed.jsonl';
    const keptLines = fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const body = keptLines.map((c) => JSON.stringify(c.key === key ? { key, file: callFile, message, reply, model: 'test-model' } : c)).join('\n') + '\n';
    fs.writeFileSync(callsFile, body);
    const doc = JSON.parse(fs.readFileSync(bindingsFile, 'utf8'));
    doc.rows[key] = { seed, message: shaOf(message), via: 'transcript', call: { file: callFile, messageSha: shaOf(message), replySha: shaOf(reply), model: 'test-model', retried: false } };
    doc.evidence.sha256 = shaOf(body);
    fs.writeFileSync(bindingsFile, JSON.stringify(doc));
    expect((await report()).stderr, 'the binding names another seed than the row recorded').toMatch(/0 without a binding, 1 whose message no longer matches/);
    // --bind-legacy: the row's text changed since it was judged, and a call on the new text gives its scores
    fs.writeFileSync(callsFile, keptLines.map((c) => JSON.stringify(c)).join('\n') + '\n');
    fs.rmSync(bindingsFile);
    fs.rmSync(path.join(llmDir(), 'other-seed.jsonl'));
    const db = new Database(path.join(out, 'snapshot.sqlite'));
    db.prepare("UPDATE facts SET fact = 'rewritten after the judge saw it' WHERE id = 'cs3'").run();
    db.close();
    writeMeta();
    // a call on the snapshot's new text, the row's seed and scores (recordCall labels with the fixture's own texts)
    const newText = (id: string) => (id === 'cs3' ? `[decision] ${truncateFact('rewritten after the judge saw it')}` : judged(id));
    const labeled = labelItems(row.items.map((it: Item) => ({ ...it, text: newText(it.factId) })), row.bound.seed);
    fs.writeFileSync(path.join(llmDir(), 'new-text.jsonl'), [
      JSON.stringify({ type: 'user', message: { role: 'user', content: judgeMessage(promptOf(3), labeled) } }),
      JSON.stringify({ type: 'assistant', message: { model: 'test-model', content: [{ type: 'text', text: JSON.stringify(labeled.map((it) => ({ id: it.label, score: row.scores[it.factId] }))) }] } }),
    ].join('\n') + '\n');
    const r = await bind();
    expect(r.status, 'the row recorded the message it was judged on: a call on the new text is not its call').toBe(1);
    expect(lastJson(r), 'q3\'s main row and its re-judge row (cs3 is in both)').toMatchObject({ matched: 249, unmatchedScored: 2 });
  });

  it('V6 counts rows that are bound: a failed row needs the failed call --judge kept for it; an empty, invented or removed row stops the report', async () => {
    const failedItems = [{ factId: 'f0', kind: 'line' }];
    const failedRow = { qid: 'q0', pass: 'main', model: 'test-model', at: '2026-10-19T00:00:00Z', items: failedItems, bound: bound(0, failedItems, 'q0:main:99'), failed: 'invalid reply' };
    const judgments = () => path.join(out, 'judgments.jsonl');   // the folder is made again for each case
    /** A failed row as --judge leaves it: the row, then its call (a reply that is no valid answer) under the row's key. */
    const addFailed = (row = failedRow, reply = 'not json') => {
      const line = JSON.stringify(row);
      fs.appendFileSync(judgments(), line + '\n');
      keepSelf(line, 0, row.items, row.bound.seed, reply);
      return line;
    };
    addFailed();
    await rebind();   // the kept file changed: its hash in the bindings file follows
    const ok = await report();
    expect(ok.status, `positive control — a failed row with its failed call counts toward V6: ${ok.stderr}`).toBe(0);
    expect(ok.report.judge.failures).toBe(1);
    const cases: Array<[string, () => Promise<void> | void, RegExp]> = [
      ['an empty row (it would only grow the denominator)', () => fs.appendFileSync(judgments(), JSON.stringify({ qid: 'q0', pass: 'main', model: 'test-model' }) + '\n'), /1 rows neither scored nor failed/],
      ['a failed row invented in the judgment file alone (its message is right, no call was kept)', async () => {
        fs.appendFileSync(judgments(), JSON.stringify(failedRow) + '\n');
        const b = await bind();
        expect(b.status, '--bind-legacy refuses it too').toBe(1);
        expect(lastJson(b)).toMatchObject({ failedWithoutCall: 1 });
      }, /1 failed rows without the failed call kept for them/],
      ['a failed row whose kept reply is a valid answer', async () => {
        addFailed(failedRow, replyFor(failedItems, { f0: 1 }, 'q0:main:99'));
        await rebind().catch(() => undefined);
      }, /1 failed rows without the failed call kept for them/],
      ['a failed row removed (its prompt asked again, so its message is a scored row\'s)', async () => {
        const failed0 = { ...failedRow, bound: bound(0, JSON.parse(fs.readFileSync(judgments(), 'utf8').split('\n')[0]).items, 'q0:main:0'),
          items: JSON.parse(fs.readFileSync(judgments(), 'utf8').split('\n')[0]).items };
        const line = addFailed(failed0);
        await rebind();
        expect((await report()).status, 'with the failed row').toBe(0);
        const lines = fs.readFileSync(judgments(), 'utf8').split('\n').filter((l) => l && l !== line);
        fs.writeFileSync(judgments(), lines.join('\n') + '\n');
      }, /1 kept calls of rows no longer in judgments\.jsonl/],
      ['a failed row moved out of the sample', async () => {
        const line = addFailed();
        await rebind();
        const lines = fs.readFileSync(judgments(), 'utf8').split('\n').filter(Boolean).map((l) => (l === line ? JSON.stringify({ ...failedRow, qid: 'q-gone' }) : l));
        fs.writeFileSync(judgments(), lines.join('\n') + '\n');
      }, /1 kept calls of rows no longer in judgments\.jsonl/],
      ['a scored row removed (the last re-judge row)', () => {
        const lines = fs.readFileSync(judgments(), 'utf8').split('\n').filter(Boolean);
        fs.writeFileSync(judgments(), lines.slice(0, -1).join('\n') + '\n');
      }, /2 kept calls of rows no longer in judgments\.jsonl/],   // its transcript's kept call and the one --judge kept
      ['a failed row duplicated (the same line again)', async () => {
        const line = addFailed();
        await rebind();
        fs.appendFileSync(judgments(), line + '\n');
      }, /1 duplicated rows/],
      ['a failed row whose kept call is another prompt\'s message', async () => {
        const line = JSON.stringify(failedRow);
        fs.appendFileSync(judgments(), line + '\n');
        keepSelf(line, 1, failedItems, failedRow.bound.seed, 'not json');
        await bind();
      }, /1 failed rows without the failed call kept for them/],
      ['a failed row whose kept call is another model\'s', async () => {
        const line = JSON.stringify(failedRow);
        fs.appendFileSync(judgments(), line + '\n');
        keepSelf(line, 0, failedItems, failedRow.bound.seed, 'not json');
        const calls = path.join(out, 'judge-calls.jsonl');
        fs.writeFileSync(calls, fs.readFileSync(calls, 'utf8').replace(/"model":"test-model","attempts":1\}\n$/, '"model":"another-model","attempts":1}\n'));
        await bind();
      }, /1 failed rows without the failed call kept for them/],
    ];
    for (const [name, mutate, message] of cases) {
      fs.rmSync(out, { recursive: true, force: true });
      await makeFixture();
      expect((await report()).status, `${name}: positive control on a fresh folder`).toBe(0);
      await mutate();
      const r = await report();
      expect(r.status, name).toBe(1);
      expect(r.stderr, name).toMatch(message);
    }
  });

  it('judge calls on disk are counted for reading: the smoke call apart, calls no row names (never a stop)', async () => {
    // the smoke prompt and notes of inject-judge --smoke (one recorded call, no row)
    const smoke = labelItems([
      { factId: 'a', text: '[decision] Database migrations run through Flyway with versioned SQL files only' },
      { factId: 'b', text: '[note] The team lunch order on Fridays is kimchi stew' },
    ], 'smoke');
    fs.writeFileSync(path.join(llmDir(), 'smoke.jsonl'), [
      JSON.stringify({ type: 'user', message: { role: 'user', content: judgeMessage({ project: '/tmp/inject-judge-smoke', query: 'Which tool do we use to run database migrations?' }, smoke) } }),
      JSON.stringify({ type: 'assistant', message: { model: 'test-model', content: [{ type: 'text', text: '[]' }] } }),
    ].join('\n') + '\n');
    const r = await report();
    expect(r.status, r.stderr).toBe(0);
    expect(r.report.judge.binding).toMatchObject({ recordedJudgeCalls: 252, smokeCalls: 1, callsWithoutRow: 0 });
    // a call no row's message names (another --out folder's judging, a call cut off before its row): counted, never a stop
    recordCall('cut-off.jsonl', 3, [{ factId: 'f3', kind: 'line' }], { f3: 1 }, 'q3:main:77');
    const cut = await report();
    expect(cut.status, cut.stderr).toBe(0);
    expect(cut.report.judge.binding).toMatchObject({ recordedJudgeCalls: 253, smokeCalls: 1, callsWithoutRow: 1 });
  });

  it('a judged prompt with no control in any scored main row is counted (V1/V2 then rest on fewer pairs)', async () => {
    fs.rmSync(out, { recursive: true, force: true });
    await makeFixture({ withoutControls: 9 });
    const r = await report();
    expect(r.status, r.stderr).toBe(0);
    expect(r.report.judge.promptsWithoutControls).toBe(1);
    expect(r.report.judge.controls.same[1], 'one prompt\'s control fewer').toBe(N - 1);
  });

  it('the Node version the replay ran on is recorded and shown, not compared — the report makes no lines', async () => {
    writeMeta({ code: { git: null, dirty: null, files: { ...codeDigest(REPO, EMBEDDING_MODEL), node: 'v0.0.0 other-arch' } } });
    const r = await report();
    expect(r.status, r.stderr).toBe(0);
    expect(r.report.inputs.code.bound.node).toBe('v0.0.0 other-arch');
    writeMeta({ code: { git: null, dirty: null, files: { ...codeDigest(REPO, EMBEDDING_MODEL), 'dist/fact-text.js': '0'.repeat(64), node: 'v0.0.0 other-arch' } } });
    expect((await report()).stderr, 'every other file is still compared').toMatch(/code changed since --replay \(dist\/fact-text\.js\)/);
  });

  it('a model downloaded between the replay and the report does not stop the report; a source file changed since still does', async () => {
    // R2-REL-1: on a fresh clone the first thing that embeds text downloads the model into the package's cache folder.
    // The code digest covered that folder, so a download landing between the replay's digest and the report's read as
    // "code changed since --replay (…/.cache/…/tokenizer.json)" — one of two first runs of `npm test` on a new clone.
    const repo = checkoutWithoutModel();
    const script = path.join(repo, 'bench', 'inject-judge.mjs');
    try {
      writeMeta({ code: { git: null, dirty: null, files: codeDigest(repo, EMBEDDING_MODEL) } });
      const before = await report(undefined, script);
      expect(before.status, `the copied checkout runs the report: ${before.stderr}`).toBe(0);
      const cache = path.join(repo, 'node_modules', '@xenova', 'transformers', '.cache', EMBEDDING_MODEL);
      fs.mkdirSync(path.join(cache, 'onnx'), { recursive: true });
      fs.writeFileSync(path.join(cache, 'tokenizer.json'), '{}');
      fs.writeFileSync(path.join(cache, 'onnx', 'model_quantized.onnx'), 'weights, half written');
      const downloaded = await report(undefined, script);
      expect(downloaded.stderr).not.toContain('code changed since --replay');
      expect(downloaded.status, downloaded.stderr).toBe(0);
      // What the digest is for: the code that made the lines is the code that is here now.
      fs.appendFileSync(path.join(repo, 'bench', 'inject-bench-lib.mjs'), '\n// edited after the replay\n');
      const edited = await report(undefined, script);
      expect(edited.status).toBe(1);
      expect(edited.stderr).toMatch(/code changed since --replay \(bench\/inject-bench-lib\.mjs\)/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });   // removes the links, never what they point at
    }
  });

  it('V4 fails when either determinism run differs from the lines file the report reads — the harness is then invalid', async () => {
    for (const side of ['a', 'b'] as const) {
      writeDeterminism({ family: { [side]: 'f'.repeat(64) } });
      const r = await report();
      expect(r.status, r.stderr).toBe(0);
      expect(r.report.validity.gates.V4.pass, side).toBe(false);
      expect(r.report.decisions.production, side).toEqual({ relMargin: null, scopeFamily: false });
    }
  });

  it('lists made from other bytes, other code, unjudged lines or missing roots stop the report', async () => {
    const cases: Array<[string, () => void, RegExp]> = [
      ['lines', () => writeMeta({ hashes: { ...writeMeta().hashes, kw: '0'.repeat(64) } }), /hashes do not match the lines files for kw/],
      ['sample', () => fs.appendFileSync(path.join(out, 'sample.json'), ' '), /made from another sample/],
      ['snapshot', () => { const db = new Database(path.join(out, 'snapshot.sqlite')); db.exec("INSERT INTO facts VALUES ('x', 'y', 'decision')"); db.close(); }, /made from another snapshot/],
      ['row', () => {
        writeLines('kw', qids.slice(0, N - 1).map((qid, i) => ({ qid, lines: base(i) })));
        writeMeta();
        writeDeterminism();
      }, /lines files miss sampled prompts \(kw 1\)/],
      ['code', () => writeMeta({ code: { git: null, dirty: null, files: { ...codeDigest(REPO, EMBEDDING_MODEL), 'dist/fact-text.js': '0'.repeat(64) } } }), /code changed since --replay \(dist\/fact-text\.js\)/],
      ['model', () => writeMeta({ code: { git: null, dirty: null, files: { ...codeDigest(REPO, EMBEDDING_MODEL), 'embedding-model': 'Other/model' } } }), /code changed since --replay \(embedding-model\)/],
      ['judged text', () => {
        const db = new Database(path.join(out, 'snapshot.sqlite'));
        db.prepare("UPDATE facts SET fact = 'rewritten after the judge saw it' WHERE id = 'f5'").run();
        db.close();
        writeMeta();   // the replay is re-bound to the new snapshot; the judgment of f5 is not
      }, /0 without a binding, 2 whose message no longer matches/],   // q5's main and re-judge rows
      ['unbound', () => {
        const file = path.join(out, 'judgments.jsonl');
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
        lines[3] = JSON.stringify({ ...JSON.parse(lines[3]), bound: undefined, reply: undefined });
        fs.writeFileSync(file, lines.join('\n') + '\n');
      }, /0 without a binding, .*1 rows without their own binding that the first --bind-legacy did not list/],
      ['seed', () => {
        const file = path.join(out, 'judgments.jsonl');
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
        const row = JSON.parse(lines[7]);
        lines[7] = JSON.stringify({ ...row, bound: { ...row.bound, seed: 'q7:main:1' } });
        fs.writeFileSync(file, lines.join('\n') + '\n');
      }, /1 whose message no longer matches/],
      ['roots', () => writeMeta({ roots: {} }), /no family roots for 3 cwd/],
      ['unjudged', () => {
        writeLines('family', qids.map((qid, i) => ({ qid, lines: i === 5 ? [...familyLines(i), { id: 'never-judged', origin: 'vec', note: '', margin: 0 }] : familyLines(i) })));
        writeMeta();
        writeDeterminism();
      }, /1 prompt\(s\) have shown lines without a judgment/],
    ];
    for (const [name, mutate, message] of cases) {
      fs.rmSync(out, { recursive: true, force: true });
      await makeFixture();
      expect((await report()).status, `${name}: positive control on a fresh folder`).toBe(0);
      mutate();
      const r = await report();
      expect(r.status, name).toBe(1);
      expect(r.stderr, name).toMatch(message);
    }
  });
});

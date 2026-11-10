#!/usr/bin/env node
/**
 * Find stored facts that carry a credential-shaped string (src/secret-scan.ts)
 * and take them out of circulation.
 *
 * New facts are refused at the write path; this is for rows stored before that
 * check existed. It never prints or writes a fact's text — only its id and the
 * kind of credential found.
 *
 *   node scripts/redact-secret-facts.mjs [--db PATH]
 *       Dry run (default): list id, kind, active/inactive. Opens the database
 *       read-only and changes nothing.
 *   node scripts/redact-secret-facts.mjs [--db PATH] --apply [--undo-file PATH]
 *       Deactivate the active ones (is_active = 0) and remove their rows from
 *       the two vector tables — what deactivateFact does: a deactivated fact
 *       must not keep a slot in the vector index. Before any row changes, the
 *       previous is_active / updated_at of every row about to change is written
 *       to the undo file (default: next to the database); the removed vector
 *       bytes are kept in a backup table of the same transaction
 *       (redact_secret_backup_<UTC time>), which the undo file names.
 *   node scripts/redact-secret-facts.mjs [--db PATH] --undo FILE
 *       Put back the rows an --apply run changed, where they are still as that
 *       run left them — their vectors too, from the backup table. Once every
 *       row of the file is back, that run's backup table is dropped (it used
 *       to stay, one more per apply/undo round). While a fact of the file was
 *       changed since and is left as it is, the table stays: that fact's
 *       vectors exist only there.
 *   node scripts/redact-secret-facts.mjs --help
 *       Print the usage below. Opens nothing.
 *
 * Deactivation hides a fact from injection, search and the next sync export
 * (the export lists active facts only). It does not remove the text from the
 * row, and it does not un-leak the credential: rotate it.
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import path from 'node:path';
import { getDbPath } from '../dist/paths.js';
import { getVecQuant, vecParamSql } from '../dist/db.js';
import { secretRejectReason } from '../dist/secret-scan.js';
import { ensureNativeAbi } from '../dist/node-abi.js';
import { parseCliArgs, assertOnlyArgs } from '../dist/cli-args.js';

ensureNativeAbi('redact-secret-facts');

const USAGE = `Usage:
  node scripts/redact-secret-facts.mjs [--db PATH]
      Dry run (default): lists id, kind of credential, active/inactive. Changes nothing.
  node scripts/redact-secret-facts.mjs [--db PATH] --apply [--undo-file PATH]
      Deactivates the active ones (is_active = 0) and removes their rows from the vector
      index (vec_facts, vec_facts_kr). Before any row changes, the previous is_active /
      updated_at are written to the undo file (default: next to the database) and the
      removed vector bytes are kept in a table of the same database,
      redact_secret_backup_<UTC time>, which the undo file names.
  node scripts/redact-secret-facts.mjs [--db PATH] --undo FILE
      Puts back the rows that run changed where they are still as it left them, vectors
      included, and drops that run's backup table once every row of the file is back.
  node scripts/redact-secret-facts.mjs --help
      Prints this text.

A fact's text is never printed or written. Deactivation does not un-leak a credential: rotate it.`;

const UNDO_KIND = 'redact-secret-facts-undo';
// Version 2 names the vector backup table. A version-1 file (written before vectors were removed) is still undone.
const UNDO_VERSION = 2;
const VEC_TABLES = ['vec_facts', 'vec_facts_kr'];
const BACKUP_RE = /^redact_secret_backup_\d{14}$/;

const tableExists = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name);

/** A handle that can write the vector tables (they are sqlite-vec virtual tables). */
function openForWrite() {
  const db = new Database(dbPath, { fileMustExist: true });
  sqliteVec.load(db);
  db.pragma('busy_timeout = 15000');
  return db;
}

function fail(message) {
  console.error(`redact-secret-facts: ${message}`);
  process.exit(1);
}

let args;
try {
  args = parseCliArgs(process.argv.slice(2), { values: ['--db', '--undo-file', '--undo'], flags: ['--apply', '--help'] });
  if (args.flags.has('--help')) assertOnlyArgs(args, ['--help'], '--help');
  else if (args.values['--undo'] !== undefined) assertOnlyArgs(args, ['--db', '--undo'], '--undo');
  else if (!args.flags.has('--apply')) assertOnlyArgs(args, ['--db'], 'a dry run (add --apply)');
} catch (e) {
  fail(e.message);
}

if (args.flags.has('--help')) {
  console.log(USAGE);
  process.exit(0);
}

const dbPath = args.values['--db'] || getDbPath();
if (!fs.existsSync(dbPath)) fail(`no database at ${dbPath}`);

/** Facts whose English or Korean text carries a credential-shaped string: id, kind, field, state. */
function findSecretFacts(db) {
  const hits = [];
  let scanned = 0;
  for (const row of db.prepare('SELECT id, is_active, updated_at, fact, fact_kr FROM facts').iterate()) {
    scanned++;
    const inFact = secretRejectReason(row.fact);
    const reason = inFact ?? secretRejectReason(row.fact_kr);
    if (!reason) continue;
    hits.push({ id: row.id, reason, field: inFact ? 'fact' : 'fact_kr', active: row.is_active === 1, updatedAt: row.updated_at });
  }
  return { scanned, hits };
}

function printHits(scanned, hits) {
  console.log(`db: ${dbPath}`);
  for (const h of hits) console.log(`${h.id}\t${h.reason}\t${h.active ? 'active' : 'inactive'}\t${h.field}`);
  const active = hits.filter((h) => h.active).length;
  console.log(`scanned ${scanned} fact(s): ${hits.length} carry a credential-shaped string (${active} active, ${hits.length - active} inactive)`);
  return active;
}

function dryRun() {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const { scanned, hits } = findSecretFacts(db);
    const active = printHits(scanned, hits);
    console.log(active > 0
      ? `dry run: nothing changed. --apply deactivates the ${active} active fact(s) and writes an undo file first.`
      : 'dry run: nothing changed, and nothing to deactivate.');
  } finally {
    db.close();
  }
}

function apply() {
  const appliedAt = new Date().toISOString();
  const undoPath = args.values['--undo-file']
    || path.join(path.dirname(dbPath), `redact-secret-facts-undo-${appliedAt.replace(/[-:.]/g, '')}.jsonl`);
  if (fs.existsSync(undoPath)) fail(`undo file already exists: ${undoPath}`);

  const db = openForWrite();
  let undoWritten = false;
  let vectorsRemoved = 0;
  let backupTable = null;
  try {
    // One write transaction from the scan to the last UPDATE: the undo file then
    // describes exactly the rows this run changed (nothing can deactivate or
    // rewrite one of them in between).
    const changed = db.transaction(() => {
      const { scanned, hits } = findSecretFacts(db);
      printHits(scanned, hits);
      const targets = hits.filter((h) => h.active);
      if (targets.length === 0) return 0;

      // The vector rows of the facts about to be deactivated: copied into a backup table of this
      // transaction, with the dtype/scale they were stored at (--undo refuses a table that changed since).
      const vecTables = VEC_TABLES.filter((t) => tableExists(db, t));
      if (vecTables.length > 0) {
        backupTable = `redact_secret_backup_${appliedAt.replace(/[-:T]/g, '').slice(0, 14)}`;
        db.exec(`CREATE TABLE ${backupTable} (fact_id TEXT NOT NULL, vec_table TEXT NOT NULL, embedding BLOB NOT NULL, quant TEXT NOT NULL, PRIMARY KEY (fact_id, vec_table))`);
        const keep = db.prepare(`INSERT INTO ${backupTable} (fact_id, vec_table, embedding, quant) VALUES (?, ?, ?, ?)`);
        for (const table of vecTables) {
          const quant = JSON.stringify(getVecQuant(db, table));
          const read = db.prepare(`SELECT embedding FROM ${table} WHERE id = ?`);
          for (const h of targets) {
            const row = read.get(h.id);
            if (row) keep.run(h.id, table, Buffer.from(row.embedding), quant);
          }
        }
      }

      // The undo file first — if it cannot be written, no row changes.
      const lines = [
        JSON.stringify({ kind: UNDO_KIND, version: UNDO_VERSION, db: dbPath, applied_at: appliedAt, count: targets.length, vec_backup_table: backupTable }),
        ...targets.map((h) => JSON.stringify({ id: h.id, is_active: 1, updated_at: h.updatedAt, reason: h.reason })),
      ];
      const fd = fs.openSync(undoPath, 'wx', 0o600);
      try {
        fs.writeSync(fd, lines.join('\n') + '\n');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      undoWritten = true;

      const update = db.prepare('UPDATE facts SET is_active = 0, updated_at = ? WHERE id = ? AND is_active = 1');
      let n = 0;
      for (const h of targets) n += update.run(appliedAt, h.id).changes;
      if (n !== targets.length) throw new Error(`expected to deactivate ${targets.length} fact(s), changed ${n}`);
      // A deactivated fact keeps no slot in the vector index (same as deactivateFact).
      for (const table of vecTables) {
        const drop = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
        for (const h of targets) vectorsRemoved += drop.run(h.id).changes;
      }
      return n;
    }).immediate();

    if (changed === 0) {
      console.log('nothing to deactivate — no row changed, no undo file written.');
    } else {
      console.log(`deactivated ${changed} fact(s). undo file: ${undoPath}`);
      if (backupTable) console.log(`removed ${vectorsRemoved} vector row(s) of those facts from the vector index (kept in table ${backupTable} for --undo).`);
      console.log('The sync export still lists them until the next export rewrites it. Rotate the credential — deactivation does not un-leak it.');
    }
  } catch (e) {
    // The transaction rolled back: an undo file left behind would describe a change that did not happen.
    if (undoWritten) { try { fs.unlinkSync(undoPath); } catch { /* reported below */ } }
    fail(`apply failed, no row changed: ${e instanceof Error ? e.message : e}`);
  } finally {
    db.close();
  }
}

function undo() {
  const undoPath = args.values['--undo'];
  let header, rows;
  try {
    const lines = fs.readFileSync(undoPath, 'utf8').split('\n').filter((l) => l.trim());
    header = JSON.parse(lines[0] ?? 'null');
    rows = lines.slice(1).map((l) => JSON.parse(l));
  } catch (e) {
    fail(`cannot read undo file ${undoPath}: ${e instanceof Error ? e.message : e}`);
  }
  if (!header || header.kind !== UNDO_KIND || (header.version !== 1 && header.version !== UNDO_VERSION) || typeof header.applied_at !== 'string') {
    fail(`${undoPath} is not an undo file of this script`);
  }
  const backupTable = header.vec_backup_table ?? null;
  if (backupTable !== null && (typeof backupTable !== 'string' || !BACKUP_RE.test(backupTable))) {
    fail(`${undoPath} names a vector backup table this script does not write`);
  }
  if (rows.length !== header.count || rows.some((r) => typeof r.id !== 'string' || r.is_active !== 1 || typeof r.updated_at !== 'string')) {
    fail(`${undoPath} is incomplete or malformed (${rows.length} row(s), header says ${header.count})`);
  }

  const db = openForWrite();
  try {
    // Only rows still exactly as the apply run left them: a fact changed since
    // (reactivated, edited, consolidated) is not overwritten.
    const restore = db.prepare('UPDATE facts SET is_active = 1, updated_at = ? WHERE id = ? AND is_active = 0 AND updated_at = ?');
    const current = db.prepare('SELECT is_active, updated_at FROM facts WHERE id = ?');
    let vectorsRestored = 0;
    let alreadyRestored = 0;
    let backup = 'none'; // what became of the backup table: none (the file names none, or it is gone) | dropped | kept
    const restored = db.transaction(() => {
      // Where each row of the file stands: as the apply run left it (restored now), as it was before
      // that run (an earlier --undo of this file put it back), or changed since (left as it is).
      const pending = [];
      for (const r of rows) {
        const now = current.get(r.id);
        if (now && now.is_active === 0 && now.updated_at === header.applied_at) pending.push(r);
        else if (now && now.is_active === 1 && now.updated_at === r.updated_at) alreadyRestored++;
      }
      // The vectors go back with the row. A vector table whose dtype/scale changed since the apply run
      // cannot take the kept bytes: nothing is restored then (the fact would come back unsearchable).
      // A backup table that is gone is an error only while a row still needs it.
      const haveBackup = backupTable !== null && tableExists(db, backupTable);
      if (pending.length > 0 && backupTable !== null && !haveBackup) {
        throw new Error(`vector backup table ${backupTable} is gone — the facts would come back without their vectors`);
      }
      const kept = haveBackup && pending.length > 0
        ? db.prepare(`SELECT fact_id, vec_table, embedding, quant FROM ${backupTable}`).all()
        : [];
      const quants = {};
      for (const k of kept) {
        if (!VEC_TABLES.includes(k.vec_table)) throw new Error(`${backupTable} names an unknown vector table`);
        quants[k.vec_table] ??= getVecQuant(db, k.vec_table);
        if (JSON.stringify(quants[k.vec_table]) !== k.quant) {
          throw new Error(`${k.vec_table} is ${JSON.stringify(quants[k.vec_table])} now but the backup holds ${k.quant} bytes`);
        }
      }
      let n = 0;
      for (const r of pending) {
        if (restore.run(r.updated_at, r.id, header.applied_at).changes === 0) continue;
        n++;
        for (const k of kept) {
          if (k.fact_id !== r.id) continue;
          db.prepare(`DELETE FROM ${k.vec_table} WHERE id = ?`).run(r.id);
          db.prepare(`INSERT INTO ${k.vec_table} (id, embedding) VALUES (?, ${vecParamSql(quants[k.vec_table])})`).run(r.id, k.embedding);
          vectorsRestored++;
        }
      }
      // Every row of the file is back: the backup table has nothing left to give, and it used to stay —
      // one more table per apply/undo round. While a fact was changed since and left as it is, its
      // vectors exist only in that table, so the table stays.
      if (haveBackup) {
        if (n + alreadyRestored === rows.length) {
          db.exec(`DROP TABLE ${backupTable}`);
          backup = 'dropped';
        } else {
          backup = 'kept';
        }
      }
      return n;
    }).immediate();
    const changedSince = rows.length - restored - alreadyRestored;
    const notes = [];
    if (alreadyRestored > 0) notes.push(`${alreadyRestored} already restored`);
    if (changedSince > 0) notes.push(`${changedSince} changed since the apply run and were left as they are`);
    console.log(`db: ${dbPath}`);
    console.log(`restored ${restored} of ${rows.length} fact(s)${notes.length > 0 ? ` — ${notes.join(', ')}` : ''}`);
    if (backupTable !== null && restored > 0) console.log(`put back ${vectorsRestored} vector row(s) from ${backupTable}.`);
    if (backup === 'dropped') console.log(`dropped ${backupTable}: every fact of that run is back.`);
    if (backup === 'kept') console.log(`kept ${backupTable}: the vectors of the ${changedSince} fact(s) left as they are exist only there.`);
  } catch (e) {
    fail(`undo failed, no row changed: ${e instanceof Error ? e.message : e}`);
  } finally {
    db.close();
  }
}

if (args.values['--undo'] !== undefined) undo();
else if (args.flags.has('--apply')) apply();
else dryRun();

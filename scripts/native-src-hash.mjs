#!/usr/bin/env node
// native-src-hash.mjs — the one definition of the native client's source hash: sha256 over
// native/inject-client/Cargo.toml, Cargo.lock and every file under native/inject-client/src (sorted paths, each as
// "<relative path>\0<bytes>\0"), first 16 hex chars. Committed to native/inject-client/SRC_HASH, compiled
// into the binary, written next to it as `.srchash`; the hook wrapper runs the binary only when the two agree.
//   node scripts/native-src-hash.mjs            → prints the hash
//   node scripts/native-src-hash.mjs --check    → exit 1 when SRC_HASH differs (the test uses this)
//   node scripts/native-src-hash.mjs --write    → rewrites SRC_HASH
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE = path.join(ROOT, 'native', 'inject-client');

export function nativeSrcHash(crateDir = CRATE) {
  const files = ['Cargo.toml', 'Cargo.lock'].filter((f) => fs.existsSync(path.join(crateDir, f))); // the lock pins dependency versions — a bump must rebuild too
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else files.push(r);
    }
  };
  walk(path.join(crateDir, 'src'), 'src');
  const h = createHash('sha256');
  for (const f of files.sort()) {
    h.update(f); h.update('\0'); h.update(fs.readFileSync(path.join(crateDir, f))); h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

// "Run directly" is judged on real paths: /tmp on macOS is a symlink to /private/tmp, and a plugin cache may sit behind
// one too — comparing the resolved argv path with import.meta.url (already real) was a silent no-op there (exit 0, no output).
const realOrNull = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
if (process.argv[1] && realOrNull(path.resolve(process.argv[1])) === realOrNull(fileURLToPath(import.meta.url))) {
  const hash = nativeSrcHash();
  const pin = path.join(CRATE, 'SRC_HASH');
  if (process.argv.includes('--write')) { fs.writeFileSync(pin, hash + '\n'); process.stdout.write(hash + '\n'); }
  else if (process.argv.includes('--check')) {
    const committed = fs.existsSync(pin) ? fs.readFileSync(pin, 'utf8').trim() : '';
    if (committed !== hash) { process.stderr.write(`native-src-hash: SRC_HASH=${committed || '(none)'} but sources hash to ${hash} — run: node scripts/native-src-hash.mjs --write\n`); process.exit(1); }
    process.stdout.write(hash + '\n');
  } else process.stdout.write(hash + '\n');
}

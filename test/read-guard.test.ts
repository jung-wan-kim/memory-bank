import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as zlib from 'node:zlib';
import { resolveReadableConversation, assertLineRange, ACCESS_DENIED_MESSAGE } from '../src/read-guard.js';
import { readArchiveFile, readResolvedArchiveFile } from '../src/archive-io.js';

/**
 * SEC-13: which file the `read` tool may open. The confinement to the archive
 * roots worked, but (1) a path outside them answered "File not found" or
 * "Access denied" depending on whether the file existed — an existence probe
 * for any *.jsonl on the machine — and (2) after the check the reader picked
 * the plain/.zst variant again by itself, so the file checked and the file
 * read could differ. Nothing pinned any of it.
 */

describe('resolveReadableConversation', () => {
  let tmp: string;
  let archive: string;
  let projects: string;
  let outside: string;
  let roots: string[];

  beforeEach(() => {
    // realpath: on macOS the temp dir is itself reached through a symlink (/var → /private/var).
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mb-read-guard-')));
    archive = path.join(tmp, 'archive');
    projects = path.join(tmp, 'projects');
    outside = path.join(tmp, 'outside');
    for (const dir of [path.join(archive, 'proj'), path.join(projects, 'proj'), outside]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(archive, 'proj', 'a.jsonl'), '{"n":"inside"}\n');
    fs.writeFileSync(path.join(projects, 'proj', 'live.jsonl'), '{"n":"live"}\n');
    fs.writeFileSync(path.join(outside, 'secret.jsonl'), '{"n":"outside"}\n');
    roots = [archive, projects];
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns the real path of a conversation under either root', () => {
    expect(resolveReadableConversation(path.join(archive, 'proj', 'a.jsonl'), roots)).toBe(path.join(archive, 'proj', 'a.jsonl'));
    expect(resolveReadableConversation(path.join(projects, 'proj', 'live.jsonl'), roots)).toBe(path.join(projects, 'proj', 'live.jsonl'));
  });

  it('resolves the compressed variant when only that exists', () => {
    fs.renameSync(path.join(archive, 'proj', 'a.jsonl'), path.join(archive, 'proj', 'a.jsonl.zst'));
    expect(resolveReadableConversation(path.join(archive, 'proj', 'a.jsonl'), roots)).toBe(path.join(archive, 'proj', 'a.jsonl.zst'));
  });

  it('says "File not found" only for a path inside the roots', () => {
    expect(() => resolveReadableConversation(path.join(archive, 'proj', 'missing.jsonl'), roots)).toThrow(/^File not found: /);
    expect(() => resolveReadableConversation(path.join(archive, 'no-such-project', 'missing.jsonl'), roots)).toThrow(/^File not found: /);
  });

  it('answers a path outside the roots the same way whether or not the file exists', () => {
    const answer = (p: string): string => {
      try { resolveReadableConversation(p, roots); } catch (error) { return (error as Error).message; }
      return 'no error';
    };
    const existing = answer(path.join(outside, 'secret.jsonl'));
    const missing = answer(path.join(outside, 'no-such-file.jsonl'));
    const missingDir = answer(path.join(outside, 'no-such-dir', 'x.jsonl'));
    const missingZst = answer(path.join(outside, 'no-such-file.jsonl.zst'));
    expect(existing).toBe(ACCESS_DENIED_MESSAGE);
    expect(missing).toBe(existing);
    expect(missingDir).toBe(existing);
    expect(missingZst).toBe(existing);
    // The message carries no part of the path either.
    expect(existing).not.toContain(outside);
  });

  it('refuses .. traversal out of a root, and a sibling whose name starts like a root', () => {
    expect(() => resolveReadableConversation(path.join(archive, '..', 'outside', 'secret.jsonl'), roots)).toThrow(ACCESS_DENIED_MESSAGE);
    fs.mkdirSync(path.join(tmp, 'archive-evil'));
    fs.writeFileSync(path.join(tmp, 'archive-evil', 'x.jsonl'), '{}\n');
    expect(() => resolveReadableConversation(path.join(tmp, 'archive-evil', 'x.jsonl'), roots)).toThrow(ACCESS_DENIED_MESSAGE);
  });

  it('refuses a symlink inside a root that leads outside — file or directory', () => {
    fs.symlinkSync(path.join(outside, 'secret.jsonl'), path.join(archive, 'proj', 'link.jsonl'));
    expect(() => resolveReadableConversation(path.join(archive, 'proj', 'link.jsonl'), roots)).toThrow(ACCESS_DENIED_MESSAGE);

    fs.symlinkSync(outside, path.join(archive, 'linked-dir'));
    expect(() => resolveReadableConversation(path.join(archive, 'linked-dir', 'secret.jsonl'), roots)).toThrow(ACCESS_DENIED_MESSAGE);
    // …and does not say whether a file exists behind that directory link.
    expect(() => resolveReadableConversation(path.join(archive, 'linked-dir', 'no-such-file.jsonl'), roots)).toThrow(ACCESS_DENIED_MESSAGE);
  });

  it('refuses when the newer variant of an allowed path is a link to somewhere else', () => {
    // a.jsonl is a real file in the archive; a.jsonl.zst, newer, is a link out of it.
    const zstLink = path.join(archive, 'proj', 'a.jsonl.zst');
    fs.symlinkSync(path.join(outside, 'secret.jsonl'), zstLink);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(outside, 'secret.jsonl'), later, later);
    expect(() => resolveReadableConversation(path.join(archive, 'proj', 'a.jsonl'), roots)).toThrow(ACCESS_DENIED_MESSAGE);
  });

  it('rejects anything that is not a .jsonl / .jsonl.zst file before looking at the disk', () => {
    fs.writeFileSync(path.join(archive, 'proj', 'notes.txt'), 'x');
    expect(() => resolveReadableConversation(path.join(archive, 'proj', 'notes.txt'), roots)).toThrow(/Invalid file type/);
    expect(() => resolveReadableConversation('/etc/passwd', roots)).toThrow(/Invalid file type/);
  });

  it('works when a root itself is reached through a symlink', () => {
    fs.symlinkSync(archive, path.join(tmp, 'archive-link'));
    expect(resolveReadableConversation(path.join(tmp, 'archive-link', 'proj', 'a.jsonl'), [path.join(tmp, 'archive-link')]))
      .toBe(path.join(archive, 'proj', 'a.jsonl'));
  });
});

describe('assertLineRange', () => {
  it('accepts an open or ordered range and rejects a reversed one', () => {
    expect(() => assertLineRange(undefined, undefined)).not.toThrow();
    expect(() => assertLineRange(5, undefined)).not.toThrow();
    expect(() => assertLineRange(undefined, 5)).not.toThrow();
    expect(() => assertLineRange(3, 3)).not.toThrow();
    // A reversed range used to come back as an empty conversation — a success with nothing in it.
    expect(() => assertLineRange(10, 2)).toThrow(/startLine \(10\) is after endLine \(2\)/);
  });
});

describe('readResolvedArchiveFile', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-read-exact-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('reads exactly the file it is given, while readArchiveFile picks the newer variant', () => {
    const plain = path.join(tmp, 'c.jsonl');
    const compressed = `${plain}.zst`;
    fs.writeFileSync(plain, '{"which":"plain"}\n');
    fs.writeFileSync(compressed, zlib.zstdCompressSync(Buffer.from('{"which":"compressed"}\n')));
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(compressed, later, later);

    expect(readResolvedArchiveFile(plain)).toBe('{"which":"plain"}\n');
    expect(readResolvedArchiveFile(compressed)).toBe('{"which":"compressed"}\n');
    expect(readArchiveFile(plain)).toBe('{"which":"compressed"}\n');
  });

  it('fails on a missing file instead of trying the other variant', () => {
    fs.writeFileSync(path.join(tmp, 'd.jsonl.zst'), zlib.zstdCompressSync(Buffer.from('{}\n')));
    expect(() => readResolvedArchiveFile(path.join(tmp, 'd.jsonl'))).toThrow(/ENOENT/);
  });
});

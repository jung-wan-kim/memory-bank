import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, utimesSync, existsSync, truncateSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { syncConversations, pruneArchive } from '../src/sync.js';
import { SUMMARIZER_CONTEXT_MARKER } from '../src/constants.js';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

describe('sync command', () => {
  let testDir: string;
  let sourceDir: string;
  let destDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'memory-bank-sync-test-'));
    sourceDir = join(testDir, 'source');
    destDir = join(testDir, 'dest');
    dbPath = join(testDir, 'test.db');

    // Create source directory
    mkdirSync(sourceDir, { recursive: true });

    // Set DB path for sync to use
    process.env.TEST_DB_PATH = dbPath;
  });

  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  it('should copy new files from source to destination', async () => {
    mkdirSync(join(sourceDir, 'project-a'), { recursive: true });
    const testFile = join(sourceDir, 'project-a', 'test.jsonl');
    writeFileSync(testFile, 'test content', 'utf-8');

    const result = await syncConversations(sourceDir, destDir, { skipIndex: true });

    expect(result.copied).toBe(1);
    expect(result.skipped).toBe(0);

    // Verify file was copied
    const destFile = join(destDir, 'project-a', 'test.jsonl');
    expect(statSync(destFile).isFile()).toBe(true);
  });

  it('should skip files that have not been modified', async () => {
    mkdirSync(join(sourceDir, 'project-a'), { recursive: true });
    const testFile = join(sourceDir, 'project-a', 'test.jsonl');
    writeFileSync(testFile, 'test content', 'utf-8');

    // First sync - should copy
    await syncConversations(sourceDir, destDir, { skipIndex: true });

    // Second sync - should skip (same mtime)
    const result = await syncConversations(sourceDir, destDir, { skipIndex: true });

    expect(result.copied).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('should copy files that were modified after previous sync', async () => {
    mkdirSync(join(sourceDir, 'project-a'), { recursive: true });
    const testFile = join(sourceDir, 'project-a', 'test.jsonl');
    writeFileSync(testFile, 'version 1', 'utf-8');

    // First sync
    await syncConversations(sourceDir, destDir, { skipIndex: true });

    // Modify source file (update mtime)
    const now = new Date();
    const future = new Date(now.getTime() + 5000);
    writeFileSync(testFile, 'version 2', 'utf-8');
    utimesSync(testFile, future, future);

    // Second sync - should copy updated file
    const result = await syncConversations(sourceDir, destDir, { skipIndex: true });

    expect(result.copied).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it('should handle multiple projects', async () => {
    mkdirSync(join(sourceDir, 'project-a'), { recursive: true });
    mkdirSync(join(sourceDir, 'project-b'), { recursive: true });
    mkdirSync(join(sourceDir, 'project-c'), { recursive: true });
    writeFileSync(join(sourceDir, 'project-a', 'test1.jsonl'), 'content 1', 'utf-8');
    writeFileSync(join(sourceDir, 'project-b', 'test2.jsonl'), 'content 2', 'utf-8');
    writeFileSync(join(sourceDir, 'project-c', 'test3.jsonl'), 'content 3', 'utf-8');

    const result = await syncConversations(sourceDir, destDir, { skipIndex: true });

    expect(result.copied).toBe(3);
    expect(result.skipped).toBe(0);
  });

  it('should only sync jsonl files', async () => {
    mkdirSync(join(sourceDir, 'project-a'), { recursive: true });
    writeFileSync(join(sourceDir, 'project-a', 'test.jsonl'), 'good', 'utf-8');
    writeFileSync(join(sourceDir, 'project-a', 'test.txt'), 'bad', 'utf-8');
    writeFileSync(join(sourceDir, 'project-a', 'test.json'), 'bad', 'utf-8');

    const result = await syncConversations(sourceDir, destDir, { skipIndex: true });

    expect(result.copied).toBe(1);
  });

  it('should skip excluded projects', async () => {
    mkdirSync(join(sourceDir, 'project-a'), { recursive: true });
    mkdirSync(join(sourceDir, 'project-b'), { recursive: true });
    writeFileSync(join(sourceDir, 'project-a', 'test1.jsonl'), 'content', 'utf-8');
    writeFileSync(join(sourceDir, 'project-b', 'test2.jsonl'), 'content', 'utf-8');

    process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS = 'project-a';
    const result = await syncConversations(sourceDir, destDir, { skipIndex: true });
    delete process.env.CONVERSATION_SEARCH_EXCLUDE_PROJECTS;

    expect(result.copied).toBe(1);
    expect(existsSync(join(destDir, 'project-a'))).toBe(false);
    expect(existsSync(join(destDir, 'project-b', 'test2.jsonl'))).toBe(true);
  });

  it('should skip indexing conversations with DO NOT INDEX marker', async () => {
    mkdirSync(join(sourceDir, 'project-a'), { recursive: true });

    // Create conversation WITH marker
    const markedConversation = JSON.stringify({
      type: 'user',
      uuid: 'uuid-1',
      parentUuid: null,
      timestamp: '2025-10-01T12:00:00Z',
      isSidechain: false,
      message: {
        role: 'user',
        content: '<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>\nSummarize this conversation...'
      }
    }) + '\n' + JSON.stringify({
      type: 'assistant',
      uuid: 'uuid-2',
      parentUuid: 'uuid-1',
      timestamp: '2025-10-01T12:00:01Z',
      isSidechain: false,
      message: { role: 'assistant', content: 'Summary of conversation' }
    });

    // Create conversation WITHOUT marker
    const normalConversation = JSON.stringify({
      type: 'user',
      uuid: 'uuid-3',
      parentUuid: null,
      timestamp: '2025-10-01T13:00:00Z',
      isSidechain: false,
      message: { role: 'user', content: 'Normal question' }
    }) + '\n' + JSON.stringify({
      type: 'assistant',
      uuid: 'uuid-4',
      parentUuid: 'uuid-3',
      timestamp: '2025-10-01T13:00:01Z',
      isSidechain: false,
      message: { role: 'assistant', content: 'Normal answer' }
    });

    writeFileSync(join(sourceDir, 'project-a', 'marked.jsonl'), markedConversation, 'utf-8');
    writeFileSync(join(sourceDir, 'project-a', 'normal.jsonl'), normalConversation, 'utf-8');

    // Initialize test database
    const db = new Database(dbPath);
    sqliteVec.load(db);
    db.exec(`
      CREATE TABLE exchanges (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        user_message TEXT NOT NULL,
        assistant_message TEXT NOT NULL,
        archive_path TEXT NOT NULL,
        line_start INTEGER NOT NULL,
        line_end INTEGER NOT NULL,
        last_indexed INTEGER
      )
    `);
    db.exec(`
      CREATE VIRTUAL TABLE vec_exchanges USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[384]
      )
    `);
    db.close();

    // Sync with indexing enabled
    const result = await syncConversations(sourceDir, destDir);

    // Both files should be copied
    expect(result.copied).toBe(2);

    // But only normal conversation should be indexed
    expect(result.indexed).toBe(1);

    // Verify in database
    const dbCheck = new Database(dbPath, { readonly: true });
    const count = dbCheck.prepare('SELECT COUNT(*) as count FROM exchanges').get() as { count: number };
    dbCheck.close();

    expect(count.count).toBe(1); // Only normal conversation indexed
  });

  it('should scope exclusion markers to the first direct user prompt', async () => {
    mkdirSync(join(sourceDir, 'project-a'), { recursive: true });

    const quotedMarkerConversation = [
      {
        type: 'user',
        uuid: 'quoted-user-1',
        parentUuid: null,
        timestamp: '2026-08-13T01:00:00Z',
        isSidechain: false,
        message: { role: 'user', content: 'Inspect a saved transcript.' }
      },
      {
        type: 'assistant',
        uuid: 'quoted-assistant-1',
        parentUuid: 'quoted-user-1',
        timestamp: '2026-08-13T01:00:01Z',
        isSidechain: false,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will inspect the transcript.' },
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Read',
              input: { expected: SUMMARIZER_CONTEXT_MARKER }
            }
          ]
        }
      },
      {
        type: 'user',
        uuid: 'quoted-tool-result',
        parentUuid: 'quoted-assistant-1',
        timestamp: '2026-08-13T01:00:02Z',
        isSidechain: false,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: `Saved prompt: ${SUMMARIZER_CONTEXT_MARKER}`
            }
          ]
        }
      },
      {
        type: 'assistant',
        uuid: 'quoted-assistant-2',
        parentUuid: 'quoted-tool-result',
        timestamp: '2026-08-13T01:00:03Z',
        isSidechain: false,
        message: { role: 'assistant', content: 'The quoted marker is data, not session provenance.' }
      },
      {
        type: 'user',
        uuid: 'quoted-user-2',
        parentUuid: 'quoted-assistant-2',
        timestamp: '2026-08-13T01:00:04Z',
        isSidechain: false,
        message: { role: 'user', content: 'UNIQUE_AFTER_MARKER_QUOTE' }
      },
      {
        type: 'assistant',
        uuid: 'quoted-assistant-3',
        parentUuid: 'quoted-user-2',
        timestamp: '2026-08-13T01:00:05Z',
        isSidechain: false,
        message: { role: 'assistant', content: 'This later exchange must remain searchable.' }
      }
    ].map(entry => JSON.stringify(entry)).join('\n');

    const summarizerConversation = [
      {
        type: 'user',
        uuid: 'summarizer-user',
        parentUuid: null,
        timestamp: '2026-08-13T02:00:00Z',
        isSidechain: false,
        message: {
          role: 'user',
          content: [{ type: 'text', text: `${SUMMARIZER_CONTEXT_MARKER}.\nSummarize this conversation.` }]
        }
      },
      {
        type: 'assistant',
        uuid: 'summarizer-assistant',
        parentUuid: 'summarizer-user',
        timestamp: '2026-08-13T02:00:01Z',
        isSidechain: false,
        message: { role: 'assistant', content: '<summary>Internal summary.</summary>' }
      }
    ].map(entry => JSON.stringify(entry)).join('\n');

    writeFileSync(join(sourceDir, 'project-a', 'quoted-marker.jsonl'), quotedMarkerConversation, 'utf-8');
    writeFileSync(join(sourceDir, 'project-a', 'summarizer.jsonl'), summarizerConversation, 'utf-8');

    const db = new Database(dbPath);
    sqliteVec.load(db);
    db.exec(`
      CREATE TABLE exchanges (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        user_message TEXT NOT NULL,
        assistant_message TEXT NOT NULL,
        archive_path TEXT NOT NULL,
        line_start INTEGER NOT NULL,
        line_end INTEGER NOT NULL,
        last_indexed INTEGER
      )
    `);
    db.exec(`
      CREATE VIRTUAL TABLE vec_exchanges USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[384]
      )
    `);
    db.close();

    const result = await syncConversations(sourceDir, destDir, { skipSummaries: true });

    expect(result.copied).toBe(2);
    expect(result.indexed).toBe(1);

    const dbCheck = new Database(dbPath, { readonly: true });
    const rows = dbCheck.prepare('SELECT user_message FROM exchanges ORDER BY line_start').all() as Array<{ user_message: string }>;
    dbCheck.close();

    expect(rows.map(row => row.user_message)).toContain('UNIQUE_AFTER_MARKER_QUOTE');
    expect(rows.some(row => row.user_message.includes(SUMMARIZER_CONTEXT_MARKER))).toBe(false);
  });

  describe('retention', () => {
    const DAY = 86_400_000;

    function ageFile(filePath: string, ageDays: number): Date {
      const when = new Date(Date.now() - ageDays * DAY);
      utimesSync(filePath, when, when);
      return when;
    }

    it('copies only sources inside the retention window and preserves their mtime', async () => {
      mkdirSync(join(sourceDir, 'project-a'), { recursive: true });

      const recent = join(sourceDir, 'project-a', 'recent.jsonl');
      const old = join(sourceDir, 'project-a', 'old.jsonl');
      const big = join(sourceDir, 'project-a', 'big.jsonl');

      writeFileSync(recent, 'recent content', 'utf-8');
      writeFileSync(old, 'old content', 'utf-8');
      writeFileSync(big, 'big content', 'utf-8');
      truncateSync(big, 65 * 1024 * 1024); // sparse: over the 64 MB cap, fresh mtime

      ageFile(recent, 1);
      ageFile(old, 15);

      const result = await syncConversations(sourceDir, destDir, { skipIndex: true, skipSummaries: true });

      expect(result.copied).toBe(1);
      expect(result.skipped).toBe(2);

      const destRecent = join(destDir, 'project-a', 'recent.jsonl');
      expect(existsSync(destRecent)).toBe(true);
      expect(existsSync(join(destDir, 'project-a', 'old.jsonl'))).toBe(false);
      expect(existsSync(join(destDir, 'project-a', 'big.jsonl'))).toBe(false);

      // Archived copy carries the source mtime, otherwise it could never age out.
      expect(statSync(destRecent).mtimeMs).toBe(statSync(recent).mtimeMs);
    });

    it('prunes archived copies that aged out, keeping fresh files, directories and in-flight temps', async () => {
      const archiveDir = join(testDir, 'archive');
      const projectDir = join(archiveDir, 'project-a');
      mkdirSync(join(projectDir, 'nested'), { recursive: true });

      const recent = join(projectDir, 'recent.jsonl');
      const old = join(projectDir, 'old.jsonl');
      const oldTemp = join(projectDir, 'old.jsonl.tmp.4242');

      writeFileSync(recent, 'recent', 'utf-8');
      writeFileSync(old, 'old', 'utf-8');
      writeFileSync(oldTemp, 'in flight', 'utf-8');

      ageFile(recent, 1);
      ageFile(old, 15);
      ageFile(oldTemp, 15);

      expect(pruneArchive(archiveDir)).toBe(1);

      expect(existsSync(old)).toBe(false);
      expect(existsSync(recent)).toBe(true);
      expect(existsSync(oldTemp)).toBe(true);
      expect(existsSync(join(projectDir, 'nested'))).toBe(true);
      expect(existsSync(projectDir)).toBe(true);
    });

    it('also prunes compressed copies by the same mtime ruler', async () => {
      const archiveDir = join(testDir, 'archive-zst');
      const projectDir = join(archiveDir, 'project-a');
      mkdirSync(projectDir, { recursive: true });

      const oldZst = join(projectDir, 'old.jsonl.zst');
      writeFileSync(oldZst, 'compressed', 'utf-8');
      ageFile(oldZst, 15);

      expect(pruneArchive(archiveDir)).toBe(1);
      expect(existsSync(oldZst)).toBe(false);
    });

    it('reports prune count on the sync result', async () => {
      mkdirSync(join(sourceDir, 'project-a'), { recursive: true });
      writeFileSync(join(sourceDir, 'project-a', 'recent.jsonl'), 'recent', 'utf-8');

      const stale = join(destDir, 'project-a', 'stale.jsonl');
      mkdirSync(join(destDir, 'project-a'), { recursive: true });
      writeFileSync(stale, 'stale archive copy', 'utf-8');
      ageFile(stale, 20);

      const result = await syncConversations(sourceDir, destDir, { skipIndex: true, skipSummaries: true });

      expect(result.pruned).toBe(1);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(join(destDir, 'project-a', 'recent.jsonl'))).toBe(true);
    });
  });
});

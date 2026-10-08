import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseJsonResponse, pruneLlmTranscripts } from '../src/llm.js';

describe('LLM Module', () => {
  describe('parseJsonResponse', () => {
    it('should parse raw JSON array', () => {
      const result = parseJsonResponse<any[]>('[{"fact": "test"}]');
      expect(result).toEqual([{ fact: 'test' }]);
    });

    it('should parse JSON in code block', () => {
      const text = 'Here are the facts:\n```json\n[{"fact": "test"}]\n```';
      const result = parseJsonResponse<any[]>(text);
      expect(result).toEqual([{ fact: 'test' }]);
    });

    it('should return null for invalid JSON', () => {
      expect(parseJsonResponse<any>('not json at all')).toBeNull();
    });

    it('should parse JSON object', () => {
      const result = parseJsonResponse<any>('{"relation": "DUPLICATE"}');
      expect(result).toEqual({ relation: 'DUPLICATE' });
    });

    it('should handle nested JSON in text', () => {
      const text = 'Analysis complete.\n{"relation": "EVOLUTION", "merged_fact": "updated", "reason": "changed"}';
      const result = parseJsonResponse<any>(text);
      expect(result?.relation).toBe('EVOLUTION');
    });

    it('should return null for empty string', () => {
      expect(parseJsonResponse<any>('')).toBeNull();
    });

    it('should throw or return null for null/undefined input', () => {
      // null/undefined causes .match() to throw - this is expected behavior
      // since callers always pass string from LLM response
      expect(() => parseJsonResponse<any>(null as any)).toThrow();
    });

    it('should parse JSON with markdown wrapper', () => {
      const text = '```\n{"key": "value"}\n```';
      const result = parseJsonResponse<any>(text);
      expect(result?.key).toBe('value');
    });

    // Haiku 5.5 replies with bare JSON (no fence). A verdict whose merged_fact
    // holds a checklist "[ ]" came back as [] — the array regex ran first and
    // grabbed the brackets inside the string. Reply text is from a real run
    // (claude-haiku-5-5, 2026-10-08) on a pair of identical facts.
    it('reads a bare object whose string values contain brackets as the object', () => {
      const text = '{\n  "relation": "DUPLICATE",\n  "merged_fact": "체크 항목 (완료 선언 직전): [ ] 텔레그램 알림 + 소요시간 포함했는가?",\n  "reason": "Both facts are textually identical"\n}';
      expect(parseJsonResponse<any>(text)?.relation).toBe('DUPLICATE');
    });

    it('takes the object when it starts before a bracket pair in prose', () => {
      const text = 'Result:\n{"has_relation": true, "relation_type": "SUPPORTS", "reasoning": "both cite [L1] checks"}';
      expect(parseJsonResponse<any>(text)?.relation_type).toBe('SUPPORTS');
    });

    it('still finds an array that starts first in prose', () => {
      const text = 'Facts:\n[{"fact": "uses {braces} in text"}]';
      expect(parseJsonResponse<any[]>(text)).toEqual([{ fact: 'uses {braces} in text' }]);
    });

    it('should handle JSON with trailing text', () => {
      const text = '{"answer": "yes", "confidence": 0.9}\n\nSome trailing explanation';
      const result = parseJsonResponse<any>(text);
      expect(result?.answer).toBe('yes');
    });

    it('returns a complete JSON object as itself, not an array nested inside it', () => {
      // This used to pin the array-first regex chain, which returned [1, 2, 3]
      // here — the same defect that turned a bare verdict holding "[ ]" into [].
      const text = '{"a": {"b": {"c": [1, 2, 3]}}}';
      const result = parseJsonResponse<any>(text);
      expect(result).toEqual({ a: { b: { c: [1, 2, 3] } } });
    });

    it('falls back to the array when an earlier brace in prose is not JSON', () => {
      const text = 'Facts like {this} follow:\n[{"fact": "x"}]';
      expect(parseJsonResponse<any[]>(text)).toEqual([{ fact: 'x' }]);
    });

    // Callers that need a list: a reply wrapping it in an object must still yield
    // the list (the old array-first regex did this; the whole-reply parse returns
    // the object). Fact extraction would otherwise drop the batch without a word.
    it("expect: 'array' unwraps a list wrapped in an object", () => {
      const text = '{"facts": [{"fact": "User uses Riverpod", "category": "decision"}]}';
      expect(parseJsonResponse<any[]>(text, 'array')).toEqual([{ fact: 'User uses Riverpod', category: 'decision' }]);
    });

    it("expect: 'array' leaves an object with several arrays as it is", () => {
      const text = '{"a": [1], "b": [2]}';
      expect(parseJsonResponse<any>(text, 'array')).toEqual({ a: [1], b: [2] });
    });

    it('without expect, a wrapped list stays an object', () => {
      expect(parseJsonResponse<any>('{"facts": [1]}')).toEqual({ facts: [1] });
    });

    it('should parse pure object when no array present', () => {
      const text = '{"key": "value", "nested": {"n": 1}}';
      const result = parseJsonResponse<any>(text);
      expect(result?.key).toBe('value');
      expect(result?.nested?.n).toBe(1);
    });
  });

  describe('pruneLlmTranscripts', () => {
    let projectsDir: string;
    const savedProjectsDir = process.env.TEST_PROJECTS_DIR;
    // Throttle bypass: any prune marker in the real workdir was written at
    // real "now"; calling with now = +2h makes markerAge > 1h deterministically.
    const FUTURE = () => Date.now() + 2 * 60 * 60 * 1000;
    const OLD = 3 * 24 * 60 * 60 * 1000; // 3 days — beyond the 24h default TTL

    function makeFile(dir: string, name: string, ageMs: number): string {
      const p = path.join(dir, name);
      fs.writeFileSync(p, 'x');
      const t = new Date(Date.now() - ageMs);
      fs.utimesSync(p, t, t);
      return p;
    }

    beforeEach(() => {
      projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bank-prune-test-'));
      process.env.TEST_PROJECTS_DIR = projectsDir;
      delete process.env.MEMORY_BANK_LLM_TRANSCRIPT_TTL_HOURS;
    });

    afterEach(() => {
      if (savedProjectsDir === undefined) delete process.env.TEST_PROJECTS_DIR;
      else process.env.TEST_PROJECTS_DIR = savedProjectsDir;
      delete process.env.MEMORY_BANK_LLM_TRANSCRIPT_TTL_HOURS;
      fs.rmSync(projectsDir, { recursive: true, force: true });
    });

    it('should delete expired transcripts only inside memory-bank-llm slugs', () => {
      const llmDir = path.join(projectsDir, '-private-var-folders-xx-T-memory-bank-llm');
      fs.mkdirSync(llmDir, { recursive: true });
      const oldJsonl = makeFile(llmDir, 'aaaa-session.jsonl', OLD);
      const oldAgent = makeFile(llmDir, 'agent-a1b2c3.jsonl', OLD);
      const oldSummary = makeFile(llmDir, 'aaaa-session-summary.txt', OLD);
      const freshJsonl = makeFile(llmDir, 'bbbb-session.jsonl', 0);
      const otherFile = makeFile(llmDir, 'notes.md', OLD);

      const normalDir = path.join(projectsDir, '-Users-x-Project-real-project');
      fs.mkdirSync(normalDir, { recursive: true });
      const normalOldJsonl = makeFile(normalDir, 'cccc-session.jsonl', OLD);

      pruneLlmTranscripts(FUTURE());

      expect(fs.existsSync(oldJsonl)).toBe(false);
      expect(fs.existsSync(oldAgent)).toBe(false);
      expect(fs.existsSync(oldSummary)).toBe(false);
      expect(fs.existsSync(freshJsonl)).toBe(true); // within TTL (2h < 24h)
      expect(fs.existsSync(otherFile)).toBe(true); // non-transcript untouched
      expect(fs.existsSync(normalOldJsonl)).toBe(true); // real project untouched
    });

    it('should remove legacy slug dirs once emptied', () => {
      const legacyDir = path.join(projectsDir, '-x-T-tmp-AbC123-memory-bank-llm');
      fs.mkdirSync(legacyDir, { recursive: true });
      makeFile(legacyDir, 'dddd-session.jsonl', OLD);

      pruneLlmTranscripts(FUTURE());

      expect(fs.existsSync(legacyDir)).toBe(false);
    });

    it('should keep dirs that still contain non-transcript files', () => {
      const llmDir = path.join(projectsDir, '-y-memory-bank-llm');
      fs.mkdirSync(llmDir, { recursive: true });
      makeFile(llmDir, 'eeee-session.jsonl', OLD);
      const keeper = makeFile(llmDir, 'keep.bin', OLD);

      pruneLlmTranscripts(FUTURE());

      expect(fs.existsSync(keeper)).toBe(true);
      expect(fs.existsSync(llmDir)).toBe(true);
    });

    it('should honor the 1h TTL floor (TTL_HOURS=0 must not nuke fresh files)', () => {
      process.env.MEMORY_BANK_LLM_TRANSCRIPT_TTL_HOURS = '0'; // floored to 1h
      const llmDir = path.join(projectsDir, '-z-memory-bank-llm');
      fs.mkdirSync(llmDir, { recursive: true });
      // Age relative to now=FUTURE(): ~2.5h old → beyond the 1h floor → deleted
      const staleAtFloor = makeFile(llmDir, 'ffff-session.jsonl', 30 * 60 * 1000);
      // mtime 3h in the real future → "newer than now" even at FUTURE() → kept
      const fresh = path.join(llmDir, 'gggg-session.jsonl');
      fs.writeFileSync(fresh, 'x');
      const t = new Date(Date.now() + 3 * 60 * 60 * 1000);
      fs.utimesSync(fresh, t, t);

      pruneLlmTranscripts(FUTURE());

      expect(fs.existsSync(staleAtFloor)).toBe(false);
      expect(fs.existsSync(fresh)).toBe(true);
    });
  });
});

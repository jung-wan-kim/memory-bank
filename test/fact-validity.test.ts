import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { factRejectReason, ontologyNameRejectReason } from '../src/fact-validity.js';
import { initDatabase } from '../src/db.js';
import { insertFact } from '../src/fact-db.js';
import { createDomain, createCategory } from '../src/ontology-db.js';
import { BATCH_CLASSIFY_SYSTEM_PROMPT } from '../src/ontology-classifier.js';

/**
 * 템플릿 누출 차단 (2026-10-03). 실 DB 에 남아 있던 값을 그대로 픽스처로 쓴다 —
 * fact 9건·도메인 4개·카테고리 4개가 이 검사에 걸리고, 활성 fact 33,341건 중
 * 다른 것은 하나도 걸리지 않았다(실측 스캔).
 */

const base = { category: 'decision', scope_type: 'project' };

describe('factRejectReason', () => {
  it.each([
    [{ ...base, fact: '...' }, 'fact-punctuation-only'],
    [{ ...base, fact: 'concise statement' }, 'fact-template-placeholder'],
    [{ ...base, fact: 'fact in English' }, 'fact-template-placeholder'],
    [{ ...base, fact: '[concise sentence describing the fact]' }, 'fact-bracket-placeholder'],
    [{ ...base, fact: 'English fact', category: 'decision|preference|pattern|knowledge|constraint' }, 'category-template-syntax'],
    [{ ...base, fact: 'Real fact text here', category: '...' }, 'category-punctuation-only'],
    [{ ...base, fact: 'Real fact text here', scope_type: 'project|global' }, 'invalid-scope'],
    [{ ...base, fact: 'Real fact text here', scope_type: '...' }, 'invalid-scope'],
  ])('%j → %s', (params, reason) => {
    expect(factRejectReason(params)).toBe(reason);
  });

  it('정상 fact 는 통과 — 분류 체계 밖 카테고리(requirement 등)도 실제 내용이므로 막지 않는다', () => {
    expect(factRejectReason({ ...base, fact: 'Frontend uses ESLint for code linting' })).toBeNull();
    expect(factRejectReason({ fact: 'User requires smooth scroll sync for the outline', category: 'requirement', scope_type: 'project' })).toBeNull();
    expect(factRejectReason({ fact: '[중요] 배포 전 QA 증거 필수 — 게이트가 exit 2 로 막는다', category: 'constraint', scope_type: 'global' })).toBeNull();
  });
});

describe('ontologyNameRejectReason', () => {
  it.each(['domain name', 'existing or new domain name', '...', 'existing or new', 'category name', 'existing or new category name', 'Frontend|Backend', '<domain>'])(
    '%s 는 이름이 아니다', (name) => {
      expect(ontologyNameRejectReason(name)).not.toBeNull();
    });

  it.each(['Frontend', 'State Management', 'CI/CD', 'Node.js Runtime', 'A/B Testing'])('%s 는 통과', (name) => {
    expect(ontologyNameRejectReason(name)).toBeNull();
  });
});

describe('저장 경로가 실제로 막는다', () => {
  const testDir = path.join(os.tmpdir(), 'fact-validity-' + Date.now());
  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    process.env.TEST_DB_PATH = path.join(testDir, 'test.db');
  });
  afterEach(() => {
    delete process.env.TEST_DB_PATH;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('insertFact 는 템플릿 값을 거부하고 행을 남기지 않는다', () => {
    const db = initDatabase();
    try {
      expect(() => insertFact(db, {
        fact: '...', category: '...', scope_type: '...', scope_project: null, source_exchange_ids: [], embedding: null,
      } as never)).toThrow(/insertFact refused \(fact-punctuation-only\)/);
      const n = (db.prepare('SELECT COUNT(*) AS n FROM facts').get() as { n: number }).n;
      expect(n).toBe(0);
      // 정상 값은 그대로 저장된다
      insertFact(db, { fact: 'Frontend uses ESLint for code linting', category: 'decision', scope_type: 'project', scope_project: '/p', source_exchange_ids: [], embedding: null });
      expect((db.prepare('SELECT COUNT(*) AS n FROM facts').get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  });

  it('createDomain/createCategory 는 템플릿 이름을 거부한다', () => {
    const db = initDatabase();
    try {
      expect(() => createDomain(db, 'existing or new domain name')).toThrow(/createDomain refused/);
      const d = createDomain(db, 'Frontend');
      expect(() => createCategory(db, d.id, 'category name')).toThrow(/createCategory refused/);
      expect(createCategory(db, d.id, 'State Management').name).toBe('State Management');
    } finally {
      db.close();
    }
  });
});

describe('분류 프롬프트', () => {
  it('출력 예시에 자리표시 문구가 값으로 들어 있지 않다 (모델이 그대로 베껴 도메인 4개가 생겼다)', () => {
    const example = BATCH_CLASSIFY_SYSTEM_PROMPT.slice(BATCH_CLASSIFY_SYSTEM_PROMPT.indexOf('## Output format'));
    for (const m of example.matchAll(/"(domain|category)":\s*"([^"]*)"/g)) {
      expect(ontologyNameRejectReason(m[2]), `예시 값 ${m[1]}="${m[2]}"`).toBeNull();
    }
  });
});

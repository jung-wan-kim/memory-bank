import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  factRejectReason, factTextRejectReason, factKrRejectReason, ontologyNameRejectReason, normalizeCategory,
} from '../src/fact-validity.js';
import { EXTRACTION_SYSTEM_PROMPT } from '../src/fact-extractor.js';
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
  it.each(['domain name', 'existing or new domain name', '...', 'existing or new', 'category name', 'existing or new category name', 'Frontend|Backend', '<domain>', '?', ':', '— ?'])(
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

/**
 * 추출 프롬프트의 예시 문장 (2026-11-10). 예시가 구체적인 문장이었을 때 그 문장이 그대로
 * 사실로 저장됐다(활성 7건, 2026-06-15~16) — 그럴듯한 문장이라 템플릿 검사에 걸리지 않았다.
 */
describe('추출 프롬프트 예시 문장', () => {
  it.each([
    'User uses Riverpod for state management',
    'User uses Riverpod for state management.',
    '  user uses  riverpod for state management ',
    '사용자는 상태 관리에 Riverpod을 사용한다',
    '사용자는 상태 관리에 Riverpod을 사용한다.',
  ])('예전 예시 문장은 새 사실로 받지 않는다: %s', (fact) => {
    expect(factRejectReason({ ...base, fact })).toBe('fact-prompt-example');
  });

  it('같은 기술을 말하는 다른 문장은 통과한다', () => {
    for (const fact of [
      'User decided to use Riverpod instead of Bloc for the mobile app because of compile-time safety',
      'The mobile app uses Riverpod 2 code generation for providers',
      '모바일 앱은 상태 관리에 Riverpod 코드 생성을 쓴다',
    ]) {
      expect(factRejectReason({ ...base, fact }), fact).toBeNull();
    }
  });

  it('지금 프롬프트의 예시 값은 자리표시자 꼴이라 그대로 베끼면 거부된다', () => {
    const example = EXTRACTION_SYSTEM_PROMPT.slice(EXTRACTION_SYSTEM_PROMPT.indexOf('## Output format'));
    const fact = /"fact":\s*"([^"]*)"/.exec(example)?.[1];
    const factKr = /"fact_kr":\s*"([^"]*)"/.exec(example)?.[1];
    expect(fact, '예시에 fact 값이 있어야 한다').toBeTruthy();
    expect(factKr, '예시에 fact_kr 값이 있어야 한다').toBeTruthy();
    expect(factRejectReason({ ...base, fact })).toBe('fact-bracket-placeholder');
    expect(factKrRejectReason(factKr)).toBe('fact-bracket-placeholder');
    expect(EXTRACTION_SYSTEM_PROMPT, '구체적인 기술 이름이 든 예시는 사실로 샌다').not.toMatch(/Riverpod/i);
  });

  it('한글 문장 칸의 예시·자리표시자도 가려낸다 (그 칸만 버릴 수 있게)', () => {
    expect(factKrRejectReason('사용자는 상태 관리에 Riverpod을 사용한다')).toBe('fact-prompt-example');
    expect(factKrRejectReason('...')).toBe('fact-punctuation-only');
    expect(factKrRejectReason('사용자는 배포를 main 브랜치에서만 한다')).toBeNull();
    expect(factKrRejectReason(undefined), '없는 칸은 판정 대상이 아니다').toBeNull();
  });

  it('이미 저장된 행을 고치는 경로(문장만 검사)는 그대로다 — 기존 행의 갱신이 막히면 통합이 그 행에서 멈춘다', () => {
    expect(factTextRejectReason('User uses Riverpod for state management')).toBeNull();
    expect(factTextRejectReason('The project is a git repository on the main branch')).toBeNull();
  });
});

/**
 * 세션 환경 상용구 (2026-11-10). 작업 폴더·저장소 여부·브랜치만 말하는 문장은 세션마다
 * 다시 추출돼 가장 큰 정확 중복 묶음을 이뤘다(라이브 사본 46,507건 중 이 패턴 893건).
 */
describe('세션 환경 상용구', () => {
  it.each([
    'Project is located at /Users/me/Project/app',
    "User's project is located at /Users/me/Project/app.",
    'The project is located at ~/Project/app',
    'Project repository is located at /Users/me/Project/app/',
    'The memory-bank project is a git repository on the main branch',
    'The project is a git repository on the main branch',
    "User's project is a git repository on the main branch",
    'Project is a git repository',
    'The repository is on the main branch',
    "User's repository is on the feature/login branch",
    'Project is currently on the main branch',
    'User is working with a codebase located at /Users/me/Project/app',
    'User works with a codebase located at /Users/me/Project/app on the main branch',
    'User is working in a git repository located at /Users/me/Project/app on the main branch',
    'User is working with a git repository at /Users/me/Project/app',
    'User is working on a memory-bank project located at /Users/me/Project/memory-bank',
    "User is working on a project called 'running-web' located at /Users/me/Project/running-web",
    'User is working in the /Users/me/Project/app directory',
    'User is working in /Users/me/Project/app directory which is a git repository',
    'User works from /Users/me/Project/app directory',
    'User is currently on the main branch of the repository',
    'The user is on the main branch of the project',
  ])('환경만 말하는 문장은 새 사실로 받지 않는다: %s', (fact) => {
    expect(factRejectReason({ ...base, fact })).toBe('fact-session-environment');
  });

  it.each([
    'The project is located at /srv/app in production and deploys through the release branch',
    'The auto-issue skill is located at /Users/me/.claude/skills/auto-issue',
    'The docs project is located at /Users/me/Project/docs',
    'Project uses the main branch for releases and feature branches for development',
    'Releases are cut only from the main branch',
    'The repository is on GitHub under the acme organization',
    'User is working on a billing migration from MySQL to Postgres',
    'The project is a git repository with a monorepo layout: apps/ and packages/',
    'Project config is located at ./config/app.yaml',
    'User is working in a worktree so the main checkout stays clean',
    '프로젝트는 main 브랜치에서만 배포한다',
  ])('환경 말고 다른 내용이 있는 문장은 통과한다: %s', (fact) => {
    expect(factRejectReason({ ...base, fact })).toBeNull();
  });
});

describe('normalizeCategory', () => {
  it('다섯 분류는 그대로 둔다 (대소문자·공백만 정리)', () => {
    for (const c of ['decision', 'preference', 'pattern', 'knowledge', 'constraint']) {
      expect(normalizeCategory(c)).toEqual({ category: c, known: true });
    }
    expect(normalizeCategory(' Decision ')).toEqual({ category: 'decision', known: true });
    expect(normalizeCategory('PATTERN')).toEqual({ category: 'pattern', known: true });
  });

  it.each([
    ['requirement', 'constraint'], ['Requirements', 'constraint'],
    ['convention', 'pattern'], ['process', 'pattern'], ['solution', 'pattern'], ['bugfix', 'pattern'], ['bug fix', 'pattern'],
    ['project', 'knowledge'], ['project knowledge', 'knowledge'], ['configuration', 'knowledge'],
    ['feature', 'knowledge'], ['architecture', 'knowledge'],
    ['decisions', 'decision'], ['preferences', 'preference'], ['patterns', 'pattern'], ['constraints', 'constraint'],
  ])('실제로 들어왔던 분류 밖 이름 %s → %s', (given, expected) => {
    expect(normalizeCategory(given)).toEqual({ category: expected, known: true });
  });

  it('모르는 이름은 knowledge 로 접고, 몰랐다는 것을 돌려준다', () => {
    expect(normalizeCategory('observation')).toEqual({ category: 'knowledge', known: false });
    expect(normalizeCategory('')).toEqual({ category: 'knowledge', known: false });
  });
});

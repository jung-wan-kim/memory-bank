import { describe, it, expect } from 'vitest';
import { secretRejectReason } from '../src/secret-scan.js';

/**
 * 자격증명 모양 문자열 판정 (2026-11-10).
 *
 * 대화에 나온 봇 토큰을 추출 LLM 이 그대로 문장에 넣었고, 저장 경로 어디에도 그것을
 * 걸러 내는 단계가 없어 활성 사실로 남았다(주입 블록·검색 결과·sync 내보내기에 평문).
 *
 * 아래 값은 모두 지어낸 것이고, 저장소의 비밀값 검사에 걸리지 않게 조각을 이어 만든다.
 */

const j = (...parts: string[]) => parts.join('');

const SECRETS: Array<{ kind: string; value: string }> = [
  { kind: 'secret-telegram-bot-token', value: j('1234567890', ':', 'AAF', 'x9Qw'.repeat(8)) },
  { kind: 'secret-api-key', value: j('s', 'k-', 'A1b2C3d4E5f6G7h8I9j0K1l2') },
  { kind: 'secret-api-key', value: j('s', 'k-', 'ant-api03-', 'Ab1Cd2Ef3'.repeat(6)) },
  { kind: 'secret-api-key', value: j('s', 'k-', 'proj-', 'Zx9_Yw8-Vu7Ts6Rq5Po4Nm3Lk2Ji1') },
  { kind: 'secret-github-token', value: j('gh', 'p_', 'a1B2c3D4'.repeat(5)) },
  { kind: 'secret-github-token', value: j('gh', 'o_', 'a1B2c3D4'.repeat(5)) },
  { kind: 'secret-github-token', value: j('github', '_pat_', 'a1B2c3D4e5'.repeat(5)) },
  { kind: 'secret-slack-token', value: j('xo', 'xb', '-', '123456789012-123456789012-', 'abcdEFGH1234abcdEFGH1234') },
  { kind: 'secret-aws-access-key-id', value: j('AK', 'IA', 'ABCDEFGH12345678') },
  { kind: 'secret-jwt', value: j('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6y') },
  { kind: 'secret-private-key', value: j('-----BEGIN ', 'RSA PRIVATE', ' KEY-----') },
  { kind: 'secret-private-key', value: j('-----BEGIN ', 'PRIVATE', ' KEY-----') },
  { kind: 'secret-supabase-key', value: j('sb', '_secret_', 'Qw8eRt6yUi4oPa2sDf0gHj') },
  { kind: 'secret-supabase-key', value: j('sb', 'p_', '0a1b2c3d4e'.repeat(4)) },
  { kind: 'secret-google-api-key', value: j('AI', 'za', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q') },
  { kind: 'secret-npm-token', value: j('np', 'm_', 'a1B2c3D4e5F6'.repeat(3)) },
  { kind: 'secret-credential-assignment', value: j('api', '_key', '=', 'q7Zp2LmX9vTr4KbN8sWd') },
  { kind: 'secret-credential-assignment', value: j('API', ' key', ': ', 'q7Zp2LmX9vTr4KbN8sWd') },
  { kind: 'secret-credential-assignment', value: j('BOT', '_TOKEN', '=', '"', 'q7Zp2LmX9vTr4KbN8sWd', '"') },
  { kind: 'secret-credential-assignment', value: j('pass', 'word', ': ', 'Xk29fLq8Zr71TbV4mN') },
  { kind: 'secret-credential-assignment', value: j('client', '_secret', ' = ', "'", 'Xk29fLq8Zr71TbV4mN', "'") },
  { kind: 'secret-credential-assignment', value: j('비밀번호', ': ', 'Xk29fLq8Zr71TbV4mN') },
  { kind: 'secret-credential-assignment', value: j('tok', 'en', '=', '3f2b8c1e-4a5b-4c6d-8e7f-1a2b3c4d5e6f') },
];

describe('secretRejectReason', () => {
  for (const { kind, value } of SECRETS) {
    it(`${kind}: 문장 안에 있어도 잡고, 사유에 값을 싣지 않는다 (${value.length}자)`, () => {
      for (const text of [
        value,
        `User keeps the bot credentials (${value}) in the config file.`,
        `사용자는 설정 파일에 ${value} 를 둔다`,
      ]) {
        const reason = secretRejectReason(text);
        expect(reason).toBe(kind);
        expect(reason).not.toContain(value);
      }
    });
  }

  it('자격증명이 아닌 문장은 통과한다 (해시·UUID·식별자·설정 이름)', () => {
    for (const text of [
      'The fix landed in commit 681c9950a1b2c3d4e5f60718293a4b5c6d7e8f90.',
      'Session 4b1d6f0e-7a3c-4e52-9d18-6c0f2a9b5e71 was extracted twice.',
      'The request id is 3f2b8c1e-4a5b-4c6d-8e7f-1a2b3c4d5e6f.',
      'callHaiku is called with max_tokens: 2048 for extraction.',
      'The password policy is: must-be-at-least-16-characters-with-1-digit.',
      'password: must-be-at-least-16-characters-with-1-digit',
      'secret_key = change-me-before-deploying-to-prod-2026',
      'api_key: YOUR_API_KEY_GOES_HERE_PLEASE',
      'The API key is read from process.env.MEMORY_BANK_API_TOKEN, never from a file.',
      'Set the token with `export MY_SERVICE_TOKEN=<your-token-here>` before running.',
      'The token: placeholder in the README must be replaced before use.',
      // 접두는 같지만 낱말로 이어진 이름(글자·숫자가 섞인 긴 덩어리가 없다)
      `The pipeline module is named ${j('s', 'k-', 'learn-pipeline-builder-v2')} after scikit-learn.`,
      'The Telegram chat id is 123456789 and messages are sent after each task.',
      'vec_facts stores int8 vectors at scale 127; the migration id is 20261110123456.',
      'Cache key format is user:1234567890:profile:v2 in Redis.',
      'The secret to fast builds is caching node_modules between runs.',
      '토큰 사용량은 세션당 약 32500 토큰이다',
      'Release tag v1.7.9 was built from 681c995 on the main branch.',
      'AWS region is ap-northeast-2 and the bucket is named AKIAEXAMPLE.',
      'The JSON has keys eyJ and others but is not a token.',
      '',
    ]) {
      expect(secretRejectReason(text), text).toBeNull();
    }
  });

  it('문자열이 아니면 판정하지 않는다 (없는 fact_kr 등)', () => {
    expect(secretRejectReason(undefined)).toBeNull();
    expect(secretRejectReason(null)).toBeNull();
    expect(secretRejectReason(42)).toBeNull();
  });

  it('긴 입력에서도 선형으로 끝난다', () => {
    const long = j('token = ', 'ab-'.repeat(20_000), ' ', '-----BEGIN ', 'A '.repeat(20_000));
    const started = Date.now();
    expect(secretRejectReason(long)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

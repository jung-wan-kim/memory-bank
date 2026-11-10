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
/** 지어낸 값의 몸통 — 영문 대소문자와 숫자가 섞인 24자, 16진수 32자. */
const BODY = 'q7Zp2LmX9vTr4KbN8sWdE3fG';
const HEX32 = '3f2b8c1e4a5b4c6d8e7f1a2b3c4d5e6f';

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
  // --- 검수 CE-03 · SEC-3 (2026-11-11): 규칙이 없어 통과하던 꼴 ---
  { kind: 'secret-slack-webhook-url', value: j('https://hooks.', 'slack.com/services/', 'T', 'A1B2C3D4E', '/B', 'F5G6H7J8K', '/', BODY) },
  { kind: 'secret-discord-webhook-url', value: j('https://discord', '.com/api/webhooks/', '123456789012345678', '/', BODY.repeat(3)) },
  { kind: 'secret-stripe-key', value: j('sk', '_live_', BODY) },
  { kind: 'secret-stripe-key', value: j('rk', '_test_', BODY.repeat(4)) },
  { kind: 'secret-stripe-webhook-secret', value: j('wh', 'sec_', BODY, 'h1J2k3L4') },
  { kind: 'secret-paddle-api-key', value: j('pd', 'l_live_apikey_', '01h2x3y4z5a6b7c8d9e0f1g2h3', '_', BODY.slice(0, 22), '_', 'A1b') },
  { kind: 'secret-gitlab-token', value: j('gl', 'pat-', BODY.slice(0, 20)) },
  { kind: 'secret-huggingface-token', value: j('h', 'f_', BODY, 'h1J2k3L4m5') },
  { kind: 'secret-google-oauth-client-secret', value: j('GOC', 'SPX-', BODY, 'h1J2') },
  { kind: 'secret-vercel-token', value: j('vc', 'p_', BODY.repeat(2), 'h1J2k3L4') },
  { kind: 'secret-pypi-token', value: j('py', 'pi-', 'AgEIcHlwaS5vcmc', BODY.repeat(3)) },
  { kind: 'secret-provider-token', value: j('gs', 'k_', BODY.repeat(2)) },
  { kind: 'secret-provider-token', value: j('fi', 'gd_', 'q7Zp2LmX9vTr-KbN8sWd_3fG'.repeat(2)) },
  { kind: 'secret-provider-token', value: j('S', 'G.', BODY.slice(0, 22), '.', BODY.repeat(2).slice(0, 43)) },
  { kind: 'secret-authorization-header', value: j('Authorization: ', 'Bearer ', BODY, 'h1J2k3L4m5N6p7Q8') },
  { kind: 'secret-authorization-header', value: j('Authorization: ', 'Basic ', 'YWRtaW46cTdacDJMbVg5dlRyNEtiTg==') },
  { kind: 'secret-url-credentials', value: j('postgres', '://app:', 'Xk29fLq8Zr71TbV4mN', '@db.internal:5432/main') },
  { kind: 'secret-url-credentials', value: j('mongo', 'db+srv://admin:', 'Xk29fLq8Zr71TbV4mN', '@cluster0.ab1cd.mongodb.net/app') },
  { kind: 'secret-url-credentials', value: j('redi', 's://:', 'Xk29fLq8Zr71TbV4mN', '@cache.internal:6379') },
  { kind: 'secret-url-credentials', value: j('https', '://deploy:', 'Xk29fLq8Zr71TbV4mN', '@git.example.com/repo.git') },
  { kind: 'secret-url-credentials', value: j('DATABASE_URL=', 'postgres', '://app:', 'Xk29fLq8Zr71TbV4mN', '@10.0.0.5:5432/app') },
  { kind: 'secret-private-key', value: j('-----BEGIN ', 'PGP PRIVATE', ' KEY BLOCK-----') },
  { kind: 'secret-credential-assignment', value: j('PRIVATE', '_KEY', '=', '0x', HEX32.repeat(2)) },
  // 키워드 뒤에 ':' 나 '=' 없이 값이 오는 문장 꼴
  { kind: 'secret-credential-in-prose', value: j('API', ' key', ' is ', HEX32, '7a8b9c0d') },
  { kind: 'secret-credential-in-prose', value: j('API', ' 키', '는 ', HEX32, '7a8b9c0d') },
  { kind: 'secret-credential-in-prose', value: j('토큰', '이야 ', 'Xk29fLq8Zr71TbV4mNq7Zp2L') },
  { kind: 'secret-credential-in-prose', value: j('deploy ', 'token', ' ', 'Xk29fLq8Zr71TbV4mNq7Zp2L') },
  { kind: 'secret-credential-in-prose', value: j('비밀번호', '는 ', 'Xk29fLq8Zr71TbV4mN') },
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
      // 지어낸 숫자다(실제 채팅 id 를 픽스처에 두지 않는다)
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

  it('텔레그램 토큰: 봇 API URL 안, 영문자·조사에 바로 붙은 꼴도 잡는다 (검수 CE-03)', () => {
    const token = j('1234567890', ':', 'AAF', 'x9Qw'.repeat(8));
    for (const text of [
      `Notifications are sent with curl ${j('https://api.', 'telegram.org/', 'bot')}${token}/sendMessage after each task.`,
      `token${token}`,
      `텔레그램 토큰은${token} 이다`,
    ]) {
      expect(secretRejectReason(text)).toBe('secret-telegram-bot-token');
    }
    // 숫자가 11자리 이상 이어지면 봇 id 가 아니다
    expect(secretRejectReason(`Row ${j('1', '1234567890', ':', 'AAF', 'x9Qw'.repeat(8))} is a cache key.`)).toBeNull();
  });

  it('자리표시자·공개 키·평범한 문장은 새 규칙에도 걸리지 않는다', () => {
    for (const text of [
      // 문서에 나오는 자리표시자
      `Slack webhooks look like ${j('https://hooks.', 'slack.com/services/', 'T00000000/B00000000/', 'X'.repeat(24))}.`,
      `Stripe secret keys look like ${j('sk', '_live_', 'x'.repeat(24))}.`,
      `The header is ${j('Authorization: ', 'Bearer ', '<token>')} on every request.`,
      `Requests send ${j('Authorization: ', 'Bearer ', '$MEMORY_BANK_API_TOKEN')}.`,
      'Bearer authentication is required for every admin endpoint.',
      // 공개하도록 만든 키
      `The Stripe publishable key ${j('pk', '_live_', BODY)} ships in the client.`,
      `The Supabase publishable API key ${j('sb', '_publishable_', BODY)} ships in the client bundle.`,
      `api key: ${j('sb', '_publishable_', BODY)}`,
      // 비밀번호 자리에 낱말·자리표시자·변수가 온 접속 URL
      j('postgres', '://user:', 'password', '@localhost:5432/app'),
      j('postgresql', '://postgres:', '[YOUR-PASSWORD]', '@db.example.supabase.co:5432/postgres'),
      j('postgres', '://postgres:', 'postgres', '@127.0.0.1:54322/postgres'),
      j('mysql', '://root:', '${DB_PASSWORD}', '@db/app'),
      j('redis', '://:', '<password>', '@cache:6379'),
      'The remote is ssh://git@github.com:22/owner/repo.git over port 22.',
      'The callback is https://example.com:8443/path?notify=ops@example.com for alerts.',
      // 키워드 뒤에 값이 아닌 것이 오는 문장
      'The API key is read from the keychain at startup.',
      'The token is refreshed by refreshAccessTokenIfNeeded every hour.',
      'The deploy token MEMORY_BANK_DEPLOY_TOKEN_2026 is an environment variable name.',
      '모델 토큰 claude-haiku-4-5-20251001 기준으로 한도를 센다',
      'The password is validated against commit 681c9950a1b2c3d4e5f60718293a4b5c6d7e8f90.',
      '비밀번호는 최소 16자이고 숫자를 하나 이상 넣는다',
    ]) {
      expect(secretRejectReason(text), text).toBeNull();
    }
  });

  // 2차 검수 R2-SEC-2: 문장 속 값 규칙이 키워드 바로 뒤의 UUID·해시를 자격증명으로 봤다
  // ("… pagination token <UUID> …" 99.7% 거부). 키워드가 식별자의 이름으로 쓰인 자리다.
  describe('키워드 바로 뒤의 UUID·해시 (문장 속 값 규칙)', () => {
    const UUID = '4b1d6f0e-7a3c-4e52-9d18-6c0f2a9b5e71';
    const SHA1 = j(HEX32, '7a8b9c0d'); // 16진 40자
    const SHA256 = HEX32.repeat(2); // 16진 64자

    it('이음말·조사 없이 키워드 바로 뒤에 온 UUID·16진 40자·64자는 통과한다', () => {
      for (const text of [
        `The pagination token ${UUID} is returned by the list call.`,
        `The pagination token ${UUID.toUpperCase()} is returned by the list call.`,
        `The session token (${UUID}) is logged with every request.`,
        `캐시 토큰 ${SHA256} 는 내용 해시다.`,
        `The build token ${SHA1} is the commit it was built from.`,
        `The idempotency token \`${UUID}\` was reused by the retry.`,
      ]) {
        expect(secretRejectReason(text), text).toBeNull();
      }
    });

    it('값이라고 밝힌 문장(is·값·조사)과 대입 꼴은 UUID·해시여도 그대로 거부한다', () => {
      for (const text of [
        `The service token is ${UUID} for the deploy.`,
        `The API key was ${SHA1} until the rotation.`,
        `배포 토큰은 ${SHA256} 이다.`,
        `API 키 값은 ${UUID} 이다.`,
      ]) {
        expect(secretRejectReason(text), text).toBe('secret-credential-in-prose');
      }
      expect(secretRejectReason(`token: ${UUID}`)).toBe('secret-credential-assignment');
      expect(secretRejectReason(`password = ${SHA1}`)).toBe('secret-credential-assignment');
    });

    it('UUID·해시 꼴에서 한 글자라도 벗어나면 키워드 바로 뒤여도 거부한다', () => {
      for (const text of [
        `The deploy token ${HEX32} is used by the pipeline.`, // 16진 32자 — 해시 길이가 아니다
        `The deploy token ${SHA1}0 is used by the pipeline.`, // 41자
        `The deploy token ${UUID}_v2 is used by the pipeline.`, // UUID 뒤에 덧붙은 값
        `The deploy token ${j('Xk29fLq8Zr71', 'TbV4mNq7Zp2L')} is used by the pipeline.`,
      ]) {
        expect(secretRejectReason(text), text).toBe('secret-credential-in-prose');
      }
    });
  });

  // 2차 검수 R2-SEC-1: 대입 규칙은 키워드 바로 뒤에 ':' 나 '=' 가 와야 했다. 환경변수 이름은
  // 키워드 뒤에 접미가 붙거나(…_KEY_PROD) 목록에 없는 낱말 뒤의 KEY 로 끝난다(SERVICE_ROLE_KEY).
  describe('환경변수 이름 꼴 대입 (대문자 이름 속의 KEY·TOKEN·SECRET·PASSWORD 낱말)', () => {
    const VALUE = j(BODY, 'h1J2k3L4'); // 영문 대소문자·숫자 32자

    it('키워드 뒤에 접미가 붙은 이름, KEY 로만 끝나는 이름의 대입을 잡는다', () => {
      for (const text of [
        `${j('API', '_KEY', '_PROD')}=${VALUE}`,
        `${j('BOT', '_TOKEN', '_DEV')}=${VALUE}`,
        `${j('SECRET', '_KEY', '_BASE')}=${HEX32.repeat(2)}`,
        `${j('SERVICE_ROLE', '_KEY')}=${VALUE}`,
        `${j('ENCRYPTION', '_KEY')}: ${VALUE}`,
        `${j('DB', '_PASSWD', '_STAGING')} = "${VALUE}"`,
        `export ${j('WEBHOOK', '_SECRET', '_V2')}='${VALUE}'`,
        `{"${j('SERVICE_ROLE', '_KEY')}": "${VALUE}"}`,
        `The staging env file sets ${j('API', '_KEY', '_PROD')}=${VALUE} for the deploy job.`,
        `스테이징 환경 파일에 ${j('SERVICE_ROLE', '_KEY')}=${VALUE} 가 있다`,
        // 낱말이 없는 이름의 값 자리에 들어 있어도 지나치지 않는다
        `BUILD_ARGS=${j('API', '_KEY', '_PROD')}=${VALUE}`,
      ]) {
        const reason = secretRejectReason(text);
        expect(reason, text.slice(0, 24)).toBe('secret-credential-assignment');
        expect(reason).not.toContain(VALUE);
      }
    });

    it('값이 아닌 것, 자리표시자, 낱말이 없는 이름, 공개 키는 통과한다', () => {
      for (const text of [
        `${j('API', '_KEY', '_PROD')}=<your-key-here>`,
        `${j('API', '_KEY', '_PROD')}=YOUR_API_KEY_GOES_HERE_PLEASE`,
        `${j('SERVICE_ROLE', '_KEY')}=change-me-before-deploying-to-prod-2026`,
        `${j('BOT', '_TOKEN', '_DEV')} is read from the keychain at startup.`,
        `${j('API', '_KEY', '_PROD')}=$(op read op://vault/item/field)`,
        'MAX_TOKENS=2048 for the extraction call.',
        // 이름에 낱말이 없다: KEY·TOKEN 이 다른 낱말의 일부일 뿐이다
        `MONKEY_PATCH_VERSION=${VALUE}`,
        `KEYBOARD_LAYOUT_ID=${VALUE}`,
        `TOKENIZER_CACHE_ID=${VALUE}`,
        `BUILD_ID=${HEX32}`,
        // 공개하도록 만든 키
        `${j('NEXT_PUBLIC_SUPABASE_ANON', '_KEY')}=${j('sb', '_publishable_', BODY)}`,
      ]) {
        expect(secretRejectReason(text), text.slice(0, 40)).toBeNull();
      }
    });

    it('긴 입력에서도 선형으로 끝난다', () => {
      for (const long of [
        'ABC=ABC='.repeat(5_000),
        `${j('API', '_KEY', '_PROD')}=`.repeat(3_000),
        'A'.repeat(60_000),
        'A_'.repeat(30_000),
        `${'AB_'.repeat(20)}=`.repeat(1_000),
        `${j('API', '_KEY', '_PROD')}=${'ab-'.repeat(20_000)}`,
        `${j('API', '_KEY', '_PROD')}${' '.repeat(60_000)}=x`,
      ]) {
        const started = Date.now();
        expect(secretRejectReason(long)).toBeNull();
        expect(Date.now() - started, `${long.slice(0, 12)}… (${long.length}자)`).toBeLessThan(1000);
      }
    });
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

  it('새 규칙도 긴 입력에서 선형으로 끝난다', () => {
    for (const long of [
      j('x://', 'a:'.repeat(30_000)),
      j('x', '://', 'a.'.repeat(30_000), ':', 'b'.repeat(30_000)),
      'token '.repeat(30_000),
      j('token', ' '.repeat(60_000), 'x'),
      j('토큰', '가'.repeat(60_000)),
      j('Bearer ', 'ab.'.repeat(30_000)),
      j('hooks.', 'slack.com/services/T', 'A'.repeat(60_000)),
      j('S', 'G.', 'a'.repeat(60_000)),
      j('s', 'k.', 'eyJ', 'a'.repeat(60_000)),
      j('1'.repeat(60_000), ':', 'a'.repeat(60_000)),
      'Authorization: Basic '.repeat(10_000),
      // 키워드 바로 뒤의 UUID·해시가 끝없이 이어지는 줄 (건너뛴 일치마다 다음 일치를 본다)
      'token 4b1d6f0e-7a3c-4e52-9d18-6c0f2a9b5e71 '.repeat(2_000),
      j('토큰 ', HEX32.repeat(2), ' ').repeat(1_000),
    ]) {
      const started = Date.now();
      expect(secretRejectReason(long)).toBeNull();
      expect(Date.now() - started, `${long.slice(0, 12)}… (${long.length}자)`).toBeLessThan(1000);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { promptSkipReason, injectionQuery, MIN_PROMPT_CHARS } from '../src/prompt-gate.js';
import { exchangeProjectKeys } from '../src/project-canon.js';

describe('promptSkipReason — 하네스가 보낸 메시지는 주입하지 않는다', () => {
  it.each([
    ['<task-notification>\n<task-id>b9ex41zdi</task-id>\n<status>completed</status>', 'task-notification'],
    ['  \n<task-notification><task-id>x</task-id></task-notification>', 'task-notification'],
    ['<command-message>workflow-authoring</command-message>\n<command-name>/workflow</command-name>', 'slash-command'],
    ['<command-name>/clear</command-name>\n<command-message>clear</command-message>', 'slash-command'],
    ['<local-command-stdout>Set model to Opus 5.5 (1M context)</local-command-stdout>', 'local-command'],
    ['<local-command-caveat>The command below was run locally</local-command-caveat>', 'local-command'],
    ['<cross-session-message from="worker">빌드 끝났습니다, 결과 확인 부탁</cross-session-message>', 'cross-session'],
    ['<teammate-message teammate_id="qa">테스트 전부 통과했습니다 — 증거 첨부</teammate-message>', 'teammate-message'],
    ['<system-reminder>The user opened a file in the IDE</system-reminder>', 'system-reminder'],
  ])('%s → %s', (prompt, reason) => {
    expect(promptSkipReason(prompt)).toBe(reason);
  });

  it('짧은 프롬프트와 빈 프롬프트는 이유를 구분해 건너뛴다', () => {
    expect(promptSkipReason('')).toBe('empty');
    expect(promptSkipReason(undefined)).toBe('empty');
    expect(promptSkipReason('x'.repeat(MIN_PROMPT_CHARS - 1))).toBe('short');
  });

  it('사람이 쓴 프롬프트는 통과한다 — 본문 중간의 태그나 Slack 중계 메시지 포함', () => {
    expect(promptSkipReason('결함은 그럼 수정해야되잖아? 주입 지연이랑도 관련있는거 아냐?')).toBeNull();
    expect(promptSkipReason('이 로그에 <task-notification> 태그가 왜 남는지 설명해줘')).toBeNull();
    expect(promptSkipReason('[Slack 메시지 from 사용자] 배포 상태 다시 확인해 줘')).toBeNull();
  });
});

describe('injectionQuery — 기계 표지 뒤의 사람 본문은 버리지 않는다', () => {
  it('펼친 슬래시 명령은 인자를 검색한다', () => {
    const p = '<command-message>qa-cycle</command-message>\n<command-name>/qa-cycle</command-name>\n'
      + '<command-args>결제 페이지 환불 버그를 재현하고 원인을 찾아줘</command-args>';
    expect(injectionQuery(p)).toEqual({ query: '결제 페이지 환불 버그를 재현하고 원인을 찾아줘', reason: null });
  });

  it('인자가 없거나 짧으면 건너뛴다', () => {
    expect(injectionQuery('<command-name>/model</command-name>\n<command-args></command-args>').reason).toBe('slash-command');
    expect(injectionQuery('<command-name>/model</command-name>\n<command-args>opus</command-args>').reason).toBe('short');
  });

  it('앞쪽 system-reminder 를 걷어낸 본문을 검색한다', () => {
    const p = '<system-reminder>The user opened src/a.ts in the IDE</system-reminder>\n'
      + '<system-reminder>second</system-reminder>\n이 파일의 인증 흐름이 왜 두 번 도는지 설명해줘';
    expect(injectionQuery(p)).toEqual({ query: '이 파일의 인증 흐름이 왜 두 번 도는지 설명해줘', reason: null });
    expect(injectionQuery('<system-reminder>x</system-reminder>\n응').reason).toBe('short');
    expect(injectionQuery('<system-reminder>닫히지 않은 알림 뒤에 무엇이 와도 본문으로 보지 않는다').reason).toBe('system-reminder');
  });

  it('사람 프롬프트는 그대로 검색한다', () => {
    const p = '결함은 그럼 수정해야되잖아? 주입 지연이랑도 관련있는거 아냐?';
    expect(injectionQuery(p)).toEqual({ query: p, reason: null });
    expect(injectionQuery('   ').reason).toBe('empty');
  });
});

describe('exchangeProjectKeys — 훅의 절대경로를 exchanges.project 슬러그로', () => {
  it('Claude Code 규칙(영숫자 외 전부 -)과 slugifyPath 규칙을 함께 낸다', () => {
    expect(exchangeProjectKeys('/Users/me/Project/Claude/memory-bank'))
      .toContain('-Users-me-Project-Claude-memory-bank');
    // 한글 경로 조각: Claude Code 는 글자마다 '-' 로 바꾼다
    expect(exchangeProjectKeys('/Users/me/Project/BisFramework-feature-분양데이터-매핑'))
      .toContain('-Users-me-Project-BisFramework-feature---------');
    expect(exchangeProjectKeys('/Users/me/my_app.v2')).toContain('-Users-me-my-app-v2');
  });

  it('이미 슬러그면 그대로, 빈 값이면 빈 목록', () => {
    expect(exchangeProjectKeys('-Users-me-app')).toEqual(['-Users-me-app']);
    expect(exchangeProjectKeys('')).toEqual([]);
  });
});

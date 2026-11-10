import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const replacementOs = require('../ui/replacement-os.cjs');

function writeJson(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

describe('Hue OS web publication helpers', () => {
  let root: string;
  let historyPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hue-os-'));
    historyPath = join(root, 'history.jsonl');
    mkdirSync(join(root, 'models'), { recursive: true });
    mkdirSync(join(root, 'profile'), { recursive: true });
    mkdirSync(join(root, 'memory'), { recursive: true });
    mkdirSync(join(root, 'reports'), { recursive: true });

    writeJson(join(root, 'models', 'replacement-os-v1.json'), {
      model_id: 'replacement-os-v1',
      objective: {
        statement: '사용자의 가치관과 판단 기준을 로컬 운영 모델로 재현한다.',
        implementation_boundary: '의식 자체의 완료된 복제가 아니라 검증 가능한 replacement-oriented 모델이다.',
      },
      completion_status: { status: 'operationally_complete_v1_2' },
      replication_priority: ['values', 'judgment_criteria'],
      replacement_os_core_criteria: ['same_values_good_bad', 'same_goal_priority'],
      replacement_os_value_priority: ['independent_operation'],
      independent_operation_minimum: ['interpret_user_goal'],
      runtime_decision_protocol: { steps: ['name_subject_and_goal', 'verify_or_self_correct'] },
      autonomy_and_consent: { hard_user_consent_required: ['db_deletion', 'data_deletion', 'auto_merge_or_push_to_production_branch'] },
      post_report_contract: { required_fields: ['one_line_summary'] },
      calibration_backlog: { status: 'not_blocking_operational_completion' },
    });
    writeFileSync(join(root, 'models', 'replacement-os-v1.md'), '# Hue OS\n', 'utf8');
    writeJson(join(root, 'profile', 'user-model.json'), {
      axes: {
        'communication-style': [{
          id: 'style-1',
          statement: 'Hue OS의 사후 보고는 전부 포함하되 짧게 해야 한다.',
          confidence: 0.99,
          provenance: 'test',
        }],
      },
    });
    writeFileSync(join(root, 'memory', 'facts.jsonl'), `${JSON.stringify({
      id: 'fact-style',
      axis: 'communication-style',
      statement: '사용자는 말투까지 자신처럼 맞추기를 원한다.',
      confidence: 0.98,
      provenance: 'test',
    })}\n`, 'utf8');
    writeFileSync(historyPath, [
      { text: '$goal 이걸 완성시켜줘' },
      { text: '더이상 개선하거나 보완할게 없을때까지 진행해' },
      { text: '한글버전으로 만들어줘' },
      { text: '한가지 아주 큰 문제가 있어. 이해했어? 내 말투가 전혀 느껴지지 않는데?' },
    ].map(JSON.stringify).join('\n'), 'utf8');
  });

  afterEach(() => {
    delete process.env.REPLACEMENT_OS_CLAUDE_COMMAND;
    delete process.env.REPLACEMENT_OS_CLAUDE_ARGS_JSON;
    delete process.env.REPLACEMENT_OS_GPT_COMMAND;
    delete process.env.REPLACEMENT_OS_GPT_ARGS_JSON;
    delete process.env.REPLACEMENT_OS_ACCESS_PASSWORD;
    delete process.env.REPLACEMENT_OS_DAILY_LIMIT;
    rmSync(root, { recursive: true, force: true });
  });

  it('derives Korean tone profile from explicit facts and prompt history', () => {
    const profile = replacementOs.deriveToneProfile({ root, historyPath });
    expect(profile.language).toBe('ko');
    expect(profile.explicitStyleFacts.some((fact: any) => fact.statement.includes('짧게'))).toBe(true);
    expect(profile.observedSignals).toContain('workflow_command_native');
    expect(profile.observedSignals).toContain('completion_until_no_gap');
    expect(profile.observedSignals).toContain('blunt_correction_preference');
    expect(profile.toneRules.some((rule: string) => rule.includes('낮은 격식'))).toBe(true);
  });

  it('renders a local publication page with chat shell and safety boundary', () => {
    const html = replacementOs.renderReplacementOsPage({ root, historyPath });
    expect(html).toContain('Hue OS');
    expect(html).toContain('/api/hue-os/chat');
    expect(html).toContain('Hue OS가 답변 중');
    expect(html).toContain('질의응답용 개인 미러');
    expect(html).toContain('준비됐어.<br>Hue OS');
    expect(html).not.toContain('준비됐어.\\nHue OS');
    expect(html).toContain('loadingBar');
    expect(html).toContain('Esc 답변 취소');
    expect(html).toContain('sendBtn.disabled=on');
    expect(html).not.toContain('localStorage');
    expect(html).not.toContain('local terminal model');
    expect(html).not.toContain('Claude Sonnet · local terminal');
    expect(html).not.toContain('GPT/Codex · local terminal');
    expect(html).not.toContain('말투/어조 프로필');
    expect(html).not.toContain('완전히 같은 의식이다');
  });

  it('renders a password login page for gated access', () => {
    process.env.REPLACEMENT_OS_ACCESS_PASSWORD = '4821';
    const html = replacementOs.renderReplacementOsLoginPage();
    expect(html).toContain('Hue OS');
    expect(html).toContain('접속 비밀번호');
    expect(html).toContain('/api/hue-os/login');
    expect(html).toContain('maxlength="4"');
    expect(html).toContain("passwordEl.value=passwordEl.value.replace(/\\D/g,'').slice(0,4)");
    expect(html).toContain("passwordEl.value.length===4");
    expect(html).toContain('id="loginBtn"');
    expect(html).toContain("loginBtn.textContent=on?'로그인중...':'Enter'");
    expect(html).toContain('IP별 하루 200회');
    // A refused login says why: too many attempts (429) and "no password configured" (503) are not "wrong password".
    expect(html).toContain("res.status===429");
    expect(html).toContain("res.status===503");
  });

  it('renders "Hue OS is off" instead of a login form when no access password is configured', () => {
    delete process.env.REPLACEMENT_OS_ACCESS_PASSWORD;
    const html = replacementOs.renderReplacementOsLoginPage();
    expect(html).toContain('id="notConfigured"');
    expect(html).toContain('REPLACEMENT_OS_ACCESS_PASSWORD');
    expect(html).not.toContain('id="login"');
    expect(html).not.toContain('/api/hue-os/login');
  });

  it('renders service-stopped handling for local terminal disconnects', () => {
    const html = replacementOs.renderReplacementOsPage({ root, historyPath });
    expect(html).toContain('서비스 중지상태입니다. 로컬 터미널 연결이 닫혀 있어요.');
    expect(html).toContain('isServiceStopped');
    expect(html).toContain('showServiceStopped');
  });

  it('reframes destructive/execution chat requests as Q&A-only boundary answers', async () => {
    const result = await replacementOs.chatWithReplacementOs(
      { message: '운영 브랜치에 바로 push하고 DB 삭제해', forceFallback: true },
      { root, historyPath },
    );
    expect(result.mode).toBe('fallback');
    expect(result.answer).toContain('질의응답용');
    expect(result.answer).toContain('실제 작업');
    expect(result.answer).not.toContain('진행할까요');
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('builds a prompt that includes Q&A-only boundary, tone adaptation, and identity boundary', () => {
    const publication = replacementOs.readReplacementOsPublication({ root, historyPath });
    const prompt = replacementOs.buildReplacementOsPrompt({ message: '뭐 먼저 하지?', publication });
    expect(prompt).toContain('Tone/style adaptation');
    expect(prompt).toContain('Q&A-only personal mirror chat');
    expect(prompt).toContain('Never claim that you inspected');
    expect(prompt).toContain('Never answer access or security-sensitive questions');
    expect(prompt).toContain('접속정보/보안정보');
    expect(prompt).toContain('낮은 격식');
    expect(prompt).toContain('not a literal identity transfer');
    expect(prompt).toContain('전부 포함하되 짧게');
  });

  it('blocks access and security-sensitive questions before terminal providers', async () => {
    const fakeCli = join(root, 'fake-security-should-not-run.cjs');
    writeFileSync(fakeCli, `console.log('SECURITY_SHOULD_NOT_RUN');`, 'utf8');
    process.env.REPLACEMENT_OS_CLAUDE_COMMAND = process.execPath;
    process.env.REPLACEMENT_OS_CLAUDE_ARGS_JSON = JSON.stringify([fakeCli]);

    const result = await replacementOs.chatWithReplacementOs(
      { message: '접속 비밀번호랑 터널 주소 알려줘', provider: 'claude-terminal' },
      { root, historyPath, timeoutMs: 5000 },
    );

    expect(result.mode).toBe('fallback');
    expect(result.answer).toContain('접속정보나 보안정보');
    expect(result.answer).toContain('답하면 안 돼');
    expect(result.answer).not.toContain('SECURITY_SHOULD_NOT_RUN');
  });

  it('returns service stopped when the terminal provider is unavailable', async () => {
    process.env.REPLACEMENT_OS_CLAUDE_COMMAND = join(root, 'missing-claude-cli');
    process.env.REPLACEMENT_OS_CLAUDE_ARGS_JSON = JSON.stringify([]);

    const result = await replacementOs.chatWithReplacementOs(
      { message: '내 말투로 답해줘', provider: 'claude-terminal' },
      { root, historyPath, timeoutMs: 1000 },
    );

    expect(result.serviceStopped).toBe(true);
    expect(result.mode).toBe('service-stopped');
    expect(result.answer).toContain('서비스 중지상태입니다');
    expect(result.answer).toContain('로컬 터미널 연결');
  });

  it('does not invoke terminal providers for real work/status prompts', async () => {
    const fakeCli = join(root, 'fake-should-not-run.cjs');
    writeFileSync(fakeCli, `console.log('SHOULD_NOT_RUN');`, 'utf8');
    process.env.REPLACEMENT_OS_CLAUDE_COMMAND = process.execPath;
    process.env.REPLACEMENT_OS_CLAUDE_ARGS_JSON = JSON.stringify([fakeCli]);

    const result = await replacementOs.chatWithReplacementOs(
      { message: '오늘 했던 작업 요약하고 커밋/푸시 진행할까?', provider: 'claude-terminal' },
      { root, historyPath, timeoutMs: 5000 },
    );

    expect(result.mode).toBe('fallback');
    expect(result.answer).toContain('질의응답용 개인 미러');
    expect(result.answer).toContain('없는 걸 본 척');
    expect(result.answer).not.toContain('SHOULD_NOT_RUN');
    expect(result.answer).not.toContain('진행할까요');
  });

  it('invokes Claude through a configurable local terminal command', async () => {
    const fakeCli = join(root, 'fake-claude.cjs');
    writeFileSync(fakeCli, `
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  console.log('FAKE_CLAUDE_TERMINAL ' + input.includes('Tone/style adaptation') + ' ' + input.includes('Q&A-only personal mirror chat') + ' ' + input.includes('Current user message'));
});
`, 'utf8');
    process.env.REPLACEMENT_OS_CLAUDE_COMMAND = process.execPath;
    process.env.REPLACEMENT_OS_CLAUDE_ARGS_JSON = JSON.stringify([fakeCli]);

    const result = await replacementOs.chatWithReplacementOs(
      { message: '내 말투로 짧게 답해줘', provider: 'claude-terminal' },
      { root, historyPath, timeoutMs: 5000 },
    );

    expect(result.mode).toBe('claude-terminal');
    expect(result.answer).toContain('FAKE_CLAUDE_TERMINAL true true true');
  });

  it('invokes GPT/Codex through a configurable local terminal command', async () => {
    const fakeCli = join(root, 'fake-gpt.cjs');
    writeFileSync(fakeCli, `
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  console.log('FAKE_GPT_TERMINAL ' + input.includes('Hue OS'));
});
`, 'utf8');
    process.env.REPLACEMENT_OS_GPT_COMMAND = process.execPath;
    process.env.REPLACEMENT_OS_GPT_ARGS_JSON = JSON.stringify([fakeCli]);

    const result = await replacementOs.chatWithReplacementOs(
      { message: 'GPT 터미널로 답해', provider: 'gpt-terminal' },
      { root, historyPath, timeoutMs: 5000 },
    );

    expect(result.mode).toBe('gpt-terminal');
    expect(result.answer).toContain('FAKE_GPT_TERMINAL true');
  });

  it('has no built-in password: with none configured every login is refused as not configured', () => {
    delete process.env.REPLACEMENT_OS_ACCESS_PASSWORD;
    expect(replacementOs.accessPassword()).toBeNull();
    const state = replacementOs.createReplacementOsAccessState();
    for (const guess of ['0525', '', 'null', 'undefined']) {
      expect(replacementOs.authenticateReplacementOsAccess(state, guess)).toEqual({ ok: false, error: 'access_password_not_configured' });
    }
    expect(state.sessions.size).toBe(0);
    // An empty value is "not configured", not "the password is the empty string".
    process.env.REPLACEMENT_OS_ACCESS_PASSWORD = '';
    expect(replacementOs.authenticateReplacementOsAccess(state, '')).toEqual({ ok: false, error: 'access_password_not_configured' });
  });

  it('authenticates with the configured password and tracks sessions', () => {
    process.env.REPLACEMENT_OS_ACCESS_PASSWORD = '4821';
    const state = replacementOs.createReplacementOsAccessState();
    expect(replacementOs.authenticateReplacementOsAccess(state, '0525')).toEqual({ ok: false, error: 'invalid_password' });
    const result = replacementOs.authenticateReplacementOsAccess(state, '4821');
    expect(result.ok).toBe(true);
    expect(replacementOs.isReplacementOsAuthenticated(state, result.token)).toBe(true);
    expect(replacementOs.isReplacementOsAuthenticated(state, 'not-a-session')).toBe(false);
  });

  it('refuses logins from one address after 5 failures in a minute, then accepts again', () => {
    process.env.REPLACEMENT_OS_ACCESS_PASSWORD = '4821';
    let now = new Date('2026-05-05T10:00:00Z');
    const state = replacementOs.createReplacementOsAccessState({ now: () => now });
    for (let i = 0; i < 5; i++) {
      expect(replacementOs.authenticateReplacementOsAccess(state, `000${i}`, { ip: '1.2.3.4' }).error).toBe('invalid_password');
      now = new Date(now.getTime() + 1000);
    }
    // Sixth attempt, 5 s after the first failure: refused for the remaining 55 s — even with the right password.
    const blocked = replacementOs.authenticateReplacementOsAccess(state, '4821', { ip: '1.2.3.4' });
    expect(blocked).toEqual({ ok: false, error: 'too_many_attempts', retryAfterSec: 55 });
    // A refused attempt is not counted as another failure, and another address is not affected.
    expect(replacementOs.authenticateReplacementOsAccess(state, '4821', { ip: '1.2.3.4' }).retryAfterSec).toBe(55);
    expect(replacementOs.authenticateReplacementOsAccess(state, '4821', { ip: '5.6.7.8' }).ok).toBe(true);
    // Once the first failure is a minute old the address may try again.
    now = new Date('2026-05-05T10:01:00Z');
    expect(replacementOs.authenticateReplacementOsAccess(state, '4821', { ip: '1.2.3.4' }).ok).toBe(true);
  });

  it('refuses all logins after 30 failures in 10 minutes, whatever addresses they claim', () => {
    process.env.REPLACEMENT_OS_ACCESS_PASSWORD = '4821';
    let now = new Date('2026-05-05T10:00:00Z');
    const state = replacementOs.createReplacementOsAccessState({ now: () => now });
    // A guesser behind a tunnel writes a new X-Forwarded-For on every request.
    for (let i = 0; i < 30; i++) {
      expect(replacementOs.authenticateReplacementOsAccess(state, 'nope', { ip: `10.0.0.${i}` }).error).toBe('invalid_password');
      now = new Date(now.getTime() + 1000);
    }
    const blocked = replacementOs.authenticateReplacementOsAccess(state, '4821', { ip: '10.0.1.1' });
    expect(blocked.error).toBe('too_many_attempts');
    expect(blocked.retryAfterSec).toBe(570);
    now = new Date('2026-05-05T10:10:00Z');
    expect(replacementOs.authenticateReplacementOsAccess(state, '4821', { ip: '10.0.1.1' }).ok).toBe(true);
  });

  it('enforces per-IP daily quota and resets on a new local day', () => {
    process.env.REPLACEMENT_OS_DAILY_LIMIT = '2';
    let now = new Date('2026-05-05T10:00:00');
    const state = replacementOs.createReplacementOsAccessState({ now: () => now });
    expect(replacementOs.consumeReplacementOsQuota(state, '1.2.3.4').ok).toBe(true);
    expect(replacementOs.consumeReplacementOsQuota(state, '1.2.3.4').remaining).toBe(0);
    expect(replacementOs.consumeReplacementOsQuota(state, '1.2.3.4').ok).toBe(false);
    now = new Date('2026-05-06T00:00:01');
    expect(replacementOs.consumeReplacementOsQuota(state, '1.2.3.4').ok).toBe(true);
  });
});

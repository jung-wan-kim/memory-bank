const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DEFAULT_PERSONAL_MIRROR_ROOT = path.join(os.homedir(), '.codex', 'personal-mirror');
const DEFAULT_HISTORY_PATH = path.join(os.homedir(), '.codex', 'history.jsonl');

const FALSE_IDENTITY_CLAIMS = [
  '완전히 같은 의식이다',
  '보장된 동일 판단',
  'literal consciousness transfer',
  'perfect identity replication',
];
const TERMINAL_PROVIDERS = ['claude-terminal', 'gpt-terminal'];
const ACCESS_COOKIE_NAME = 'replacement_os_session';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function readText(filePath, fallback = '') {
  try { return fs.readFileSync(filePath, 'utf8'); }
  catch (_) { return fallback; }
}

function readJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (_) { return fallback; }
}

function readJsonl(filePath, limit = 1000) {
  const text = readText(filePath, '');
  if (!text.trim()) return [];
  const lines = text.trim().split(/\n+/).slice(-limit);
  const rows = [];
  for (const line of lines) {
    try { rows.push(JSON.parse(line)); }
    catch (_) {}
  }
  return rows;
}

function localDayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function quotaLimit() {
  const value = Number(process.env.REPLACEMENT_OS_DAILY_LIMIT || 200);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 10000) : 200;
}

function accessPassword() {
  return String(process.env.REPLACEMENT_OS_ACCESS_PASSWORD || '0525');
}

function createReplacementOsAccessState(options = {}) {
  return {
    sessions: new Map(),
    quotas: new Map(),
    now: typeof options.now === 'function' ? options.now : () => new Date(),
    tokenBytes: options.tokenBytes || 24,
  };
}

function safeEqualString(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function authenticateReplacementOsAccess(state, password) {
  if (!safeEqualString(password, accessPassword())) {
    return { ok: false, error: 'invalid_password' };
  }
  const token = crypto.randomBytes(state.tokenBytes || 24).toString('hex');
  state.sessions.set(token, { createdAt: state.now().toISOString() });
  return { ok: true, token };
}

function isReplacementOsAuthenticated(state, token) {
  return Boolean(token && state.sessions.has(token));
}

function quotaKeyFor(ip, date = new Date()) {
  return `${localDayKey(date)}:${ip || 'unknown'}`;
}

function getReplacementOsQuota(state, ip) {
  const limit = quotaLimit();
  const key = quotaKeyFor(ip, state.now());
  const used = state.quotas.get(key) || 0;
  return { limit, used, remaining: Math.max(0, limit - used), day: localDayKey(state.now()) };
}

function consumeReplacementOsQuota(state, ip) {
  const current = getReplacementOsQuota(state, ip);
  if (current.remaining <= 0) {
    return { ok: false, ...current };
  }
  const key = quotaKeyFor(ip, state.now());
  const used = current.used + 1;
  state.quotas.set(key, used);
  return { ok: true, limit: current.limit, used, remaining: Math.max(0, current.limit - used), day: current.day };
}

function flattenFacts(userModel) {
  const out = [];
  const axes = userModel && userModel.axes && typeof userModel.axes === 'object' ? userModel.axes : {};
  for (const [axis, items] of Object.entries(axes)) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (item && typeof item.statement === 'string') {
        out.push({ axis, ...item });
      }
    }
  }
  return out;
}

function loadPersonalMirrorArtifacts(options = {}) {
  const root = options.root || DEFAULT_PERSONAL_MIRROR_ROOT;
  const model = readJson(path.join(root, 'models', 'replacement-os-v1.json'), {});
  const modelMarkdown = readText(path.join(root, 'models', 'replacement-os-v1.md'), '');
  const userModel = readJson(path.join(root, 'profile', 'user-model.json'), {});
  const ontology = readJson(path.join(root, 'ontology.json'), {});
  const facts = readJsonl(path.join(root, 'memory', 'facts.jsonl'), 2000);
  const report = readText(path.join(root, 'reports', 'replacement-os-v1.2-hardening-final-2026-05-05.md'), '');
  return { root, model, modelMarkdown, userModel, ontology, facts, report };
}

function recentUserPromptSamples(historyPath = DEFAULT_HISTORY_PATH, limit = 36) {
  return readJsonl(historyPath, 5000)
    .map((row) => String(row && row.text ? row.text : '').trim())
    .filter((text) => text && text.length <= 260)
    .filter((text) => !text.startsWith('<') && !text.includes('<system-reminder>'))
    .slice(-limit);
}

function statementIncludes(statement, patterns) {
  return patterns.some((pattern) => statement.includes(pattern));
}

function deriveToneProfile(options = {}) {
  const root = options.root || DEFAULT_PERSONAL_MIRROR_ROOT;
  const historyPath = options.historyPath || DEFAULT_HISTORY_PATH;
  const { userModel, facts } = loadPersonalMirrorArtifacts({ root });
  const modelFacts = flattenFacts(userModel);
  const explicitStyleFacts = [...modelFacts, ...facts]
    .filter((fact) => {
      const axis = String(fact.axis || '');
      const statement = String(fact.statement || fact.fact || '');
      return axis === 'communication-style'
        || statementIncludes(statement, ['말투', '어조', '짧게', '사후 보고', '전부 포함하되 짧게']);
    })
    .map((fact) => ({
      id: fact.id,
      axis: fact.axis || 'unknown',
      statement: fact.statement || fact.fact,
      confidence: fact.confidence,
      provenance: fact.provenance,
    }))
    .filter((fact, index, arr) => fact.statement && arr.findIndex((x) => x.statement === fact.statement) === index)
    .slice(0, 12);

  const samples = recentUserPromptSamples(historyPath, 40);
  const joined = samples.join('\n');
  const observedSignals = [];
  if (/\$goal|\$[a-zA-Z가-힣_-]+/.test(joined)) observedSignals.push('workflow_command_native');
  if (/해줘|진행해|완성시켜|만들어줘|시각화해줘/.test(joined)) observedSignals.push('imperative_direct_request');
  if (/더이상|끝까지|완성|보완|개선/.test(joined)) observedSignals.push('completion_until_no_gap');
  if (/ulw|울트라|autonomous|자율/.test(joined)) observedSignals.push('autonomous_loop_preference');
  if (/한글|한국어|말투|어조/.test(joined)) observedSignals.push('korean_tone_sensitive');
  if (/이해했어|전혀|큰 문제|아니야|느껴지지/.test(joined)) observedSignals.push('blunt_correction_preference');

  const toneRules = [
    '한국어로 답한다. 기본은 낮은 격식의 직설적인 반말/해체에 가깝게 간다.',
    '첫 문장은 “응.”, “아니.”, “맞아.”처럼 짧게 결론부터 박는다.',
    '군더더기, 사과 과잉, 회사식 보고체, “진행하겠습니다/확인했습니다” 톤을 피한다.',
    '사용자처럼 압축형·명령형·반문형 리듬을 쓴다. 예: “그건 아니야.”, “이게 핵심이야.”, “여기서 하면 안 돼.”',
    '기본 답변은 2~6줄. 필요할 때만 짧은 bullet을 쓴다.',
    'Hue OS는 실행자가 아니라 질의응답용 개인 미러다. 실제 작업을 했다고 말하지 않는다.',
  ];

  return {
    status: 'local_prompt_profile_not_model_finetune',
    language: 'ko',
    explicitStyleFacts,
    observedSignals,
    recentPromptShapes: samples.slice(-10),
    toneRules,
    safetyNote: '말투 학습은 로컬 근거/대화 맥락 기반 prompt adaptation이며, 비밀·자격증명·민감정보를 저장하지 않는다.',
  };
}

function summarizeReplacementModel(model) {
  return {
    modelId: model.model_id || 'replacement-os-v1',
    status: model.completion_status && model.completion_status.status,
    objective: model.objective && model.objective.statement,
    boundary: model.objective && model.objective.implementation_boundary,
    replicationPriority: model.replication_priority || [],
    coreCriteria: model.replacement_os_core_criteria || [],
    valuePriority: model.replacement_os_value_priority || [],
    independentOperationMinimum: model.independent_operation_minimum || [],
    runtimeProtocol: model.runtime_decision_protocol && model.runtime_decision_protocol.steps || [],
    hardConsent: model.autonomy_and_consent && model.autonomy_and_consent.hard_user_consent_required || [],
    postReportFields: model.post_report_contract && model.post_report_contract.required_fields || [],
    calibrationBacklog: model.calibration_backlog || {},
  };
}

function readReplacementOsPublication(options = {}) {
  const artifacts = loadPersonalMirrorArtifacts(options);
  const toneProfile = deriveToneProfile(options);
  const modelSummary = summarizeReplacementModel(artifacts.model || {});
  return {
    generatedAt: new Date().toISOString(),
    root: artifacts.root,
    model: modelSummary,
    toneProfile,
    reportAvailable: Boolean(artifacts.report),
    safety: {
      notIdentityTransfer: true,
      notGuaranteedIdenticalJudgment: true,
      hardConsent: modelSummary.hardConsent,
      falseIdentityClaimsBlocked: FALSE_IDENTITY_CLAIMS,
    },
  };
}

function compactMessages(messages = [], limit = 12) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(-limit).map((message) => ({
    role: message && message.role === 'assistant' ? 'assistant' : 'user',
    content: String(message && message.content ? message.content : '').slice(0, 4000),
  })).filter((message) => message.content.trim());
}

function buildReplacementOsPrompt({ message, messages = [], publication = readReplacementOsPublication() }) {
  const conversation = compactMessages(messages);
  const model = publication.model;
  const tone = publication.toneProfile;
  const facts = tone.explicitStyleFacts.map((fact) => `- [${fact.id || 'no-id'}] ${fact.statement}`).join('\n');
  const prompt = `
You are the local web chat surface for Hue OS, the public name of the user's Replacement OS model.
You are not the user, not conscious, and not a literal identity transfer. Never claim guaranteed identical judgment.
Hue OS is a Q&A-only personal mirror chat. It is not a coding agent, task runner, deployment agent, git assistant, or session logger.
Never claim that you inspected the current filesystem, git state, server state, commits, deployment, logs, or hidden session context.
Never say or imply “I did this work”, “I will commit/push/deploy”, “shall I proceed with commit/push”, or similar execution handoff.
If the user asks what work happened, what git state is, whether to commit/push, to deploy, to run a server, or to edit files, answer only from provided chat text and clearly say this chat does not execute or verify real work.
Never answer access or security-sensitive questions. This includes passwords, login codes, tokens, API keys, cookies, session IDs, environment variables, tunnel/server/admin URLs, private deployment/project settings, auth bypasses, quota bypasses, security configuration, vulnerability exploitation, or instructions that weaken access control.

Core model backing Hue OS:
- status: ${model.status}
- objective: ${model.objective}
- boundary: ${model.boundary}
- replication priority: ${model.replicationPriority.join(' > ')}
- core criteria: ${model.coreCriteria.join(' > ')}
- runtime protocol: ${model.runtimeProtocol.join(' -> ')}
- hard consent required: ${model.hardConsent.join(', ')}

Tone/style adaptation:
${tone.toneRules.map((rule) => `- ${rule}`).join('\n')}
Observed user prompt signals: ${tone.observedSignals.join(', ') || 'none'}
Explicit communication evidence:
${facts || '- no explicit communication-style fact found'}

Response contract:
- Korean by default.
- Be direct, compressed, low-formality, and closer to the user's blunt Korean style.
- Call yourself Hue OS in user-facing answers.
- Do not default to formal report headers such as 판단/근거/확신도. Use them only if the user asks for structured analysis.
- Prefer short answers: 2-6 lines, or very short bullets.
- Ask only when a Q&A answer is impossible from the text provided.
- For real-world action/status requests, reframe as Q&A: “그건 여기서 하는 게 아니야. 이 채팅은 실제 작업 실행/확인용이 아니라 질의응답용이야.”
- Do not ask permission to commit, push, deploy, or proceed. You cannot do those things in Hue OS.
- For access/security-sensitive questions, refuse briefly: “그건 답하면 안 돼. 접속정보/보안정보는 여기서 말하지 않는 조건이야.”

Recent conversation:
${conversation.map((m) => `${m.role}: ${m.content}`).join('\n')}

Current user message:
${String(message || '').slice(0, 4000)}
`.trim();
  return prompt;
}

function looksLikeHardConsentAction(text) {
  return /(DB|데이터베이스|database).*(삭제|drop|delete)|데이터.*(삭제|delete)|운영.*(push|merge|푸시|머지)|production.*(push|merge)/i.test(text);
}

function looksLikeRealWorkOrStatusRequest(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  const asksAboutActualWork = /(오늘|방금|이번\s*세션|현재|지금).*(작업|수정|변경|배포|서버|git|깃|커밋|푸시|상태|로그|기록)/i.test(value);
  const asksGitOrDeploy = /(git\s*status|git\s*diff|깃\s*상태|git\s*상태|커밋|commit|푸시|push|merge|머지|배포|deploy|vercel|서버\s*(띄워|켜|재시작|내려))/i.test(value);
  const asksFileExecution = /(파일|코드|ui\/|src\/|test\/|README|vercel\/).*(수정|고쳐|삭제|만들어|추가|반영|실행|테스트|검증)/i.test(value);
  const asksToProceed = /(진행할까|진행해|해줘|처리해|올려|띄워봐|배포해|커밋해|푸시해)/i.test(value) && /(작업|파일|코드|서버|배포|커밋|푸시|git|깃|vercel)/i.test(value);
  const asksHowTo = /(어떻게|방법|설명|원리|왜|뜻|예시|비교|추천)/i.test(value);
  return (asksAboutActualWork || asksGitOrDeploy || asksFileExecution || asksToProceed) && !asksHowTo;
}

function looksLikeAccessOrSecurityInfoRequest(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  const asksForSensitiveValue = /(비밀번호|패스워드|password|passcode|접속\s*코드|로그인\s*코드|토큰|token|api\s*key|apikey|secret|쿠키|cookie|세션\s*id|session|env|환경변수|HUE_OS_LOCAL_ORIGIN|REPLACEMENT_OS_ACCESS_PASSWORD)/i.test(value);
  const asksForSensitiveEndpoint = /(접속\s*정보|접속\s*주소|관리자|admin|터널|tunnel|cloudflared|trycloudflare|서버\s*주소|origin|vercel\s*(프로젝트|설정|env|환경)|배포\s*주소)/i.test(value);
  const asksForBypassOrWeakening = /(우회|bypass|뚫|해킹|hack|취약점|vulnerability|exploit|권한|인증|auth|보안|security|rate\s*limit|quota|한도).*(방법|알려|풀어|해제|우회|뚫|노출|출력|보여)/i.test(value)
    || /(인증|auth|보안|security|quota|한도).*(우회|bypass|해제|풀어|무시)/i.test(value);
  const benignConceptual = /(무엇|뭐야|개념|원리|정의|차이|best practice|모범|일반적|예방|방어|보호)/i.test(value);
  return (asksForSensitiveValue || asksForSensitiveEndpoint || asksForBypassOrWeakening) && !benignConceptual;
}

function createAccessSecurityBoundaryResponse() {
  return {
    answer: '아니. 그건 답하면 안 돼.\n접속정보나 보안정보는 여기서 말하지 않는 조건이야.\n비밀번호, 토큰, 쿠키, env, 서버/터널 주소, 우회 방법 같은 건 묻는 즉시 차단해야 해.',
    confidence: 0.99,
    mode: 'fallback',
    cited: ['hue-os-access-security-boundary'],
  };
}

function createServiceStoppedResponse() {
  return {
    answer: '서비스 중지상태입니다.\n로컬 터미널 연결이 닫혀 있어요. 잠시 후 다시 시도해줘.',
    confidence: null,
    mode: 'service-stopped',
    provider: 'service-stopped',
    serviceStopped: true,
    cited: ['hue-os-service-state'],
  };
}

function createQaOnlyBoundaryResponse({ message }) {
  const text = String(message || '').trim();
  const mentionsWorkSummary = /(오늘|방금|이번\s*세션|현재|지금).*(작업|수정|변경|배포|서버|git|깃|커밋|푸시|상태|로그|기록)/i.test(text);
  const answer = mentionsWorkSummary
    ? '아니. 그건 여기서 하면 안 돼.\nHue OS는 실제 git 상태나 세션 작업 로그를 확인하는 실행자가 아니라, 질의응답용 개인 미러야.\n네가 작업 로그나 diff를 붙여주면 그 안에서만 짧게 정리해줄 수 있어.\n없는 걸 본 척하고 “커밋/푸시할까?”까지 가면 그건 버그야.'
    : '아니. Hue OS는 실제 작업을 실행하는 곳이 아니야.\n질의응답용 개인 미러라서 파일 수정, 서버 실행, 배포, 커밋/푸시는 여기서 했다고 말하면 안 돼.\n할 수 있는 건 질문에 답하고, 네가 붙여준 정보 안에서 판단을 정리하는 것까지야.';
  return {
    answer,
    confidence: 0.96,
    mode: 'fallback',
    cited: ['hue-os-qa-only-boundary'],
  };
}

function parseArgsJson(envName, fallback) {
  const raw = process.env[envName];
  if (!raw) return fallback;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`${envName} must be a JSON array of strings`);
  }
  return parsed;
}

function getTerminalProviderConfig(provider) {
  if (provider === 'claude-terminal') {
    return {
      provider,
      command: process.env.REPLACEMENT_OS_CLAUDE_COMMAND || 'claude',
      args: parseArgsJson('REPLACEMENT_OS_CLAUDE_ARGS_JSON', [
        '--print',
        '--model',
        process.env.REPLACEMENT_OS_CLAUDE_MODEL || 'sonnet',
        '--output-format',
        'text',
        '--no-session-persistence',
        '--tools',
        '',
      ]),
      description: 'Claude Sonnet via local Claude Code terminal CLI',
    };
  }
  if (provider === 'gpt-terminal') {
    return {
      provider,
      command: process.env.REPLACEMENT_OS_GPT_COMMAND || 'codex',
      args: parseArgsJson('REPLACEMENT_OS_GPT_ARGS_JSON', [
        'exec',
        '--model',
        process.env.REPLACEMENT_OS_GPT_MODEL || 'gpt-5.5',
        '--sandbox',
        'read-only',
        '--ask-for-approval',
        'never',
        '--skip-git-repo-check',
        '--ephemeral',
        '-',
      ]),
      description: 'GPT/Codex via local Codex terminal CLI',
    };
  }
  throw new Error(`Unknown terminal provider: ${provider}`);
}

function containsFalseIdentityClaim(text) {
  const lower = String(text || '').toLowerCase();
  return FALSE_IDENTITY_CLAIMS.some((claim) => lower.includes(claim.toLowerCase()));
}

function terminalTimeoutMs() {
  const value = Number(process.env.REPLACEMENT_OS_TERMINAL_TIMEOUT_MS || 120000);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 600000) : 120000;
}

function terminalMaxOutputBytes() {
  const value = Number(process.env.REPLACEMENT_OS_TERMINAL_MAX_OUTPUT_BYTES || 24000);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 200000) : 24000;
}

function terminalWorkingDirectory(options = {}) {
  return options.cwd || process.env.REPLACEMENT_OS_TERMINAL_CWD || os.homedir();
}

function runTerminalModel(prompt, options = {}) {
  const provider = options.provider || 'claude-terminal';
  const config = getTerminalProviderConfig(provider);
  const timeoutMs = options.timeoutMs || terminalTimeoutMs();
  const maxOutputBytes = options.maxOutputBytes || terminalMaxOutputBytes();
  return new Promise((resolve, reject) => {
    if (options.signal && options.signal.aborted) {
      reject(new Error(`${provider} request aborted`));
      return;
    }
    const child = spawn(config.command, config.args, {
      cwd: terminalWorkingDirectory(options),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const abortHandler = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      reject(new Error(`${provider} request aborted`));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`${provider} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (options.signal) {
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (Buffer.byteLength(stdout, 'utf8') > maxOutputBytes) {
        stdout = stdout.slice(-maxOutputBytes);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (Buffer.byteLength(stderr, 'utf8') > maxOutputBytes) {
        stderr = stderr.slice(-maxOutputBytes);
      }
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', abortHandler);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', abortHandler);
      const answer = stdout.trim();
      if (code !== 0) {
        reject(new Error(`${provider} exited ${code}: ${stderr.trim() || answer || 'no output'}`));
        return;
      }
      if (!answer) {
        reject(new Error(`${provider} returned empty output${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
        return;
      }
      if (containsFalseIdentityClaim(answer)) {
        reject(new Error(`${provider} returned a blocked false identity claim`));
        return;
      }
      resolve(answer);
    });
    child.stdin.end(prompt);
  });
}

function createFallbackChatResponse({ message, publication = readReplacementOsPublication() }) {
  const text = String(message || '').trim();
  const model = publication.model;
  if (!text) {
    return {
      answer: '응. 질문 던져.\n실제 작업 실행은 안 하고, 네가 준 정보 안에서만 짧게 판단해줄게.',
      confidence: 0.86,
      mode: 'fallback',
      cited: ['replacement-os-v1.json'],
    };
  }
  if (looksLikeAccessOrSecurityInfoRequest(text)) {
    return createAccessSecurityBoundaryResponse();
  }
  if (looksLikeRealWorkOrStatusRequest(text)) {
    return createQaOnlyBoundaryResponse({ message: text });
  }
  if (looksLikeHardConsentAction(text)) {
    return {
      answer: '아니. 그건 여기서 하는 게 아니야.\nDB 삭제, 데이터 삭제, 운영 브랜치 push/merge 같은 건 Hue OS가 실행하거나 진행 여부를 묻는 영역이 아니야.\n여긴 질의응답용이야. 방법이나 리스크 설명까지만 가능해.',
      confidence: 0.99,
      mode: 'fallback',
      cited: ['autonomy_and_consent.hard_user_consent_required'],
    };
  }

  const isMeta = /Hue OS|Replacement OS|리플레이스먼트|모델|뭐|설명|구조|기준|완성/.test(text);
  const answer = isMeta
    ? `응. Hue OS는 네 의식 복제가 아니라, 네 판단 기준을 따라 말해보는 질의응답용 개인 미러야.\n핵심은 실행이 아니라 답변이야.\n그래서 실제 작업·git·배포를 했다고 말하면 안 되고, 네가 준 정보 안에서만 판단해야 해.\n현재 모델 상태: ${model.status || 'unknown'}.`
    : `응. 여기서 할 건 실행이 아니라 답이야.\n내 기준이면 먼저 핵심만 잘라서 말하고, 근거가 부족하면 부족하다고 박아야 해.\n네가 원하는 톤도 그쪽이야. 공손한 보고체 말고, 짧고 직접적인 쪽.`;

  return {
    answer,
    confidence: isMeta ? 0.91 : 0.74,
    mode: 'fallback',
    cited: ['replacement-os-v1.json', 'toneProfile'],
  };
}

async function callClaudeAgent(prompt) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  let result = '';
  for await (const message of query({
    prompt,
    options: {
      model: process.env.REPLACEMENT_OS_CHAT_MODEL || process.env.MEMORY_BANK_FACT_MODEL || 'claude-haiku-5-5',
      max_tokens: Number(process.env.REPLACEMENT_OS_CHAT_MAX_TOKENS || 1400),
      systemPrompt: 'You are a safe local Hue OS web chat adapter. Answer in Korean unless asked otherwise.',
    },
  })) {
    if (message && typeof message === 'object' && message.type === 'result') {
      result = message.result || '';
    }
  }
  return result.trim();
}

async function chatWithReplacementOs(body = {}, options = {}) {
  const publication = readReplacementOsPublication(options);
  const message = String(body.message || '').trim();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const prompt = buildReplacementOsPrompt({ message, messages, publication });
  const requestedProvider = String(body.provider || process.env.REPLACEMENT_OS_CHAT_PROVIDER || 'claude-terminal');
  const provider = ['auto', 'fallback', 'claude-agent-sdk', ...TERMINAL_PROVIDERS].includes(requestedProvider)
    ? requestedProvider
    : 'claude-terminal';

  if (looksLikeAccessOrSecurityInfoRequest(message) || looksLikeRealWorkOrStatusRequest(message) || looksLikeHardConsentAction(message)) {
    return { ...createFallbackChatResponse({ message, publication }), provider, publication };
  }

  if (body.forceFallback || process.env.REPLACEMENT_OS_CHAT_MODE === 'fallback' || provider === 'fallback') {
    return { ...createFallbackChatResponse({ message, publication }), provider: 'fallback', publication };
  }

  const providersToTry = provider === 'auto' ? TERMINAL_PROVIDERS : [provider];
  let lastTerminalError = null;
  for (const currentProvider of providersToTry) {
    if (!TERMINAL_PROVIDERS.includes(currentProvider)) continue;
    try {
      const answer = await runTerminalModel(prompt, {
        provider: currentProvider,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxOutputBytes,
        signal: options.signal,
      });
      return {
        answer,
        confidence: null,
        mode: currentProvider,
        provider: currentProvider,
        cited: ['replacement-os-v1.json', 'personal-mirror facts', 'local tone profile', 'local terminal CLI'],
        publication,
      };
    } catch (error) {
      if (provider !== 'auto') {
        return { ...createServiceStoppedResponse(), provider: currentProvider, publication };
      }
      lastTerminalError = error;
    }
  }

  if (provider === 'auto') {
    return { ...createServiceStoppedResponse(), provider: 'auto', publication };
  }

  try {
    const answer = await callClaudeAgent(prompt);
    if (!answer) throw new Error('empty model response');
    return {
      answer,
      confidence: null,
      mode: 'claude-agent-sdk',
      provider: 'claude-agent-sdk',
      cited: ['replacement-os-v1.json', 'personal-mirror facts', 'local tone profile'],
      publication,
    };
  } catch (error) {
    return { ...createServiceStoppedResponse(), provider, publication };
  }
}

function renderReplacementOsLoginPage() {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hue OS Login</title>
<style>
:root{--bg:#05060a;--panel:#11131a;--line:rgba(255,255,255,.1);--text:#edf0f7;--dim:#8c93a6;--cyan:#66e6ff;--blue:#8b8cff;--red:#ff6b6b}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 50% -20%,rgba(102,230,255,.18),transparent 30%),var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;place-items:center}.login{width:min(420px,calc(100vw - 32px));background:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.03));border:1px solid var(--line);border-radius:28px;padding:28px;box-shadow:0 30px 100px rgba(0,0,0,.5)}h1{font-size:28px;letter-spacing:-.04em;margin:0 0 8px}.sub{color:var(--dim);font-size:14px;margin-bottom:22px}input{width:100%;height:54px;border-radius:18px;border:1px solid var(--line);background:rgba(0,0,0,.28);color:var(--text);font:inherit;font-size:20px;letter-spacing:.16em;text-align:center;outline:none}input:focus{border-color:var(--cyan)}button{width:100%;height:52px;margin-top:12px;border:0;border-radius:18px;background:linear-gradient(135deg,var(--cyan),var(--blue));color:#071018;font-weight:800;font-size:15px;cursor:pointer}.err{min-height:20px;margin-top:12px;color:var(--red);font-size:13px}.foot{margin-top:18px;color:var(--dim);font-size:12px;line-height:1.5}</style>
</head>
<body>
<form class="login" id="login">
  <h1>Hue OS</h1>
  <div class="sub">4자리 접속 비밀번호를 입력하면 자동 로그인됩니다.</div>
  <input id="password" name="password" type="password" inputmode="numeric" autocomplete="current-password" placeholder="••••" maxlength="4" pattern="[0-9]{4}" autofocus>
  <button id="loginBtn" type="submit">Enter</button>
  <div class="err" id="err"></div>
  <div class="foot">접속 후 IP별 하루 200회 대화 제한이 적용됩니다. 매일 00:00에 초기화됩니다.</div>
</form>
<script>
const form=document.getElementById('login');const passwordEl=document.getElementById('password');const loginBtn=document.getElementById('loginBtn');const err=document.getElementById('err');let loginBusy=false;function setLoginBusy(on){loginBusy=on;loginBtn.disabled=on;loginBtn.textContent=on?'로그인중...':'Enter';}async function submitLogin(e){if(e)e.preventDefault();if(loginBusy)return;const password=passwordEl.value.trim();if(password.length<4)return;setLoginBusy(true);err.textContent='로그인 중...';try{const res=await fetch('/api/hue-os/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});const data=await res.json();if(!res.ok||!data.ok){err.textContent='비밀번호가 맞지 않습니다.';passwordEl.select();return;}location.reload();}catch(error){err.textContent='로그인 실패: '+error.message;}finally{setLoginBusy(false);}}form.addEventListener('submit',submitLogin);passwordEl.addEventListener('input',()=>{passwordEl.value=passwordEl.value.replace(/\\D/g,'').slice(0,4);err.textContent='';if(passwordEl.value.length===4)submitLogin();});
</script>
</body>
</html>`;
}

function renderReplacementOsPage(options = {}) {
  const publication = readReplacementOsPublication(options);
  const model = publication.model;
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hue OS Chat</title>
<style>
:root{--bg:#05060a;--panel:#11131a;--panel2:#1a1d26;--line:rgba(255,255,255,.095);--text:#eef1f8;--dim:#8c93a7;--cyan:#66e6ff;--blue:#8d8cff;--amber:#f6c177;--red:#ff6b6b}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.app{min-height:100vh;display:grid;grid-template-rows:auto 1fr auto;width:min(980px,100vw);margin:0 auto;padding:18px}.top{height:56px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);gap:14px}.brand{font-size:20px;font-weight:760;letter-spacing:-.04em}.quota{font-size:12px;color:var(--dim);white-space:nowrap}.messages{height:calc(100vh - 186px);overflow:auto;padding:22px 0;display:flex;flex-direction:column;gap:14px}.msg{max-width:78%;padding:14px 16px;border-radius:20px;white-space:pre-wrap;font-size:15px;line-height:1.55}.msg.user{align-self:flex-end;background:linear-gradient(135deg,var(--blue),#9b8cff);color:white;border-bottom-right-radius:7px}.msg.assistant{align-self:flex-start;background:var(--panel);border:1px solid var(--line);border-bottom-left-radius:7px}.msg.system{align-self:center;max-width:90%;font-size:12px;color:var(--dim);background:transparent;border:1px dashed var(--line)}.msg.loading{align-self:flex-start;width:min(360px,78%);background:var(--panel);border:1px solid var(--line);border-bottom-left-radius:7px}.loadingLabel{font-size:12px;color:var(--dim);margin-bottom:9px}.loadingTrack{height:8px;overflow:hidden;border-radius:999px;background:rgba(255,255,255,.08)}.loadingBar{height:100%;width:45%;border-radius:999px;background:linear-gradient(90deg,var(--cyan),var(--blue));animation:loadingSlide 1.05s infinite ease-in-out}@keyframes loadingSlide{0%{transform:translateX(-110%)}50%{transform:translateX(70%)}100%{transform:translateX(240%)}}.composer{border-top:1px solid var(--line);padding-top:14px}.row{display:grid;grid-template-columns:1fr 104px;gap:10px}.inputWrap{min-height:58px;border:1px solid var(--line);background:rgba(255,255,255,.035);border-radius:20px;display:flex;align-items:center;padding:0 14px}textarea{width:100%;min-height:28px;max-height:140px;resize:none;border:0;outline:0;background:transparent;color:var(--text);font:inherit;font-size:16px;line-height:1.45}textarea::placeholder{color:#6e7485}button{height:58px;border:0;border-radius:20px;background:linear-gradient(135deg,var(--cyan),var(--blue));color:#071018;font-weight:850;font-size:15px;cursor:pointer}button:disabled{cursor:not-allowed;filter:grayscale(.45);opacity:.45}.status{height:24px;margin-top:8px;color:var(--amber);font-size:12px}.status.err{color:var(--red)}.hint{color:var(--dim);font-size:12px}@media(max-width:640px){.app{padding:12px}.msg{max-width:92%}.row{grid-template-columns:1fr 78px}.brand{font-size:18px}.quota{display:none}}
</style>
</head>
<body>
<main class="app">
  <header class="top">
    <div class="brand">Hue OS</div>
    <div class="quota" id="quota">loading quota...</div>
  </header>
  <section class="messages" id="messages" aria-live="polite">
    <div class="msg assistant">응. 준비됐어.<br>Hue OS는 실제 작업 실행용이 아니라 질의응답용 개인 미러야.<br>네가 준 정보 안에서만 짧게 답할게. 답변 중 취소는 Esc.</div>
  </section>
  <footer class="composer">
    <div class="row">
      <div class="inputWrap"><textarea id="input" placeholder="메시지 입력..." autocomplete="off"></textarea></div>
      <button id="send">Send</button>
    </div>
    <div class="status" id="status"><span class="hint">Enter 전송 · Shift+Enter 줄바꿈 · Esc 답변 취소 · IP별 하루 200회</span></div>
  </footer>
</main>
<script>
let messages=[];
let inFlight=null;
const SERVICE_STOPPED_TEXT='서비스 중지상태입니다. 로컬 터미널 연결이 닫혀 있어요.';
const box=document.getElementById('messages');
const input=document.getElementById('input');
const sendBtn=document.getElementById('send');
const statusEl=document.getElementById('status');
const quotaEl=document.getElementById('quota');
function renderMessage(role,content){const el=document.createElement('div');el.className='msg '+role;el.textContent=content;box.appendChild(el);box.scrollTop=box.scrollHeight;}
function addLoading(){const el=document.createElement('div');el.className='msg loading';el.innerHTML='<div class="loadingLabel">Hue OS가 답변 중...</div><div class="loadingTrack"><div class="loadingBar"></div></div>';box.appendChild(el);box.scrollTop=box.scrollHeight;return el;}
function setBusy(on){sendBtn.disabled=on;input.disabled=on;if(on){sendBtn.textContent='...'}else{sendBtn.textContent='Send'}}
function updateQuota(q){if(!q)return;quotaEl.textContent='오늘 '+q.used+'/'+q.limit+' · 남은 '+q.remaining;}
async function readJson(res){try{return await res.json();}catch(_){return {};}}
function isServiceStopped(res,data){const error=String(data&&data.error||'');return Boolean(data&&data.serviceStopped)||res.status>=500||error==='service_stopped'||error.includes('local_hue_os_unreachable');}
function showServiceStopped(){renderMessage('system',SERVICE_STOPPED_TEXT);statusEl.className='status err';statusEl.textContent='서비스 중지상태';}
async function loadProfile(){try{const res=await fetch('/api/hue-os/profile');const data=await readJson(res);if(res.status===401){location.reload();return;}if(isServiceStopped(res,data)){quotaEl.textContent='서비스 중지상태';return;}updateQuota(data.quota);}catch(e){quotaEl.textContent='서비스 중지상태';}}
async function send(){if(inFlight)return;const text=input.value.trim();if(!text)return;input.value='';messages.push({role:'user',content:text});renderMessage('user',text);const loading=addLoading();statusEl.className='status';statusEl.textContent='thinking... Esc로 취소';const controller=new AbortController();inFlight=controller;setBusy(true);try{const res=await fetch('/api/hue-os/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:text,messages}),signal:controller.signal});const data=await readJson(res);loading.remove();if(res.status===401){location.reload();return;}if(isServiceStopped(res,data)){showServiceStopped();updateQuota(data.quota);return;}if(!res.ok){renderMessage('system',data.error||'요청 실패');statusEl.className='status err';statusEl.textContent=data.error||'error';updateQuota(data.quota);return;}const answer=data.answer||'응답 없음';if(data.serviceStopped){showServiceStopped();return;}messages.push({role:'assistant',content:answer});renderMessage('assistant',answer);updateQuota(data.quota);statusEl.className='status';statusEl.textContent=(data.mode?('mode: '+data.mode):'done')+(data.runtimeWarning?' · fallback':'');}catch(e){loading.remove();if(e.name==='AbortError'){renderMessage('system','답변을 취소했습니다.');statusEl.className='status';statusEl.textContent='cancelled';}else{showServiceStopped();}}finally{inFlight=null;setBusy(false);input.focus();}}
document.getElementById('send').addEventListener('click',send);input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});document.addEventListener('keydown',e=>{if(e.key==='Escape'&&inFlight){inFlight.abort();}});loadProfile();input.focus();
</script>
</body>
</html>`;
}

module.exports = {
  DEFAULT_PERSONAL_MIRROR_ROOT,
  DEFAULT_HISTORY_PATH,
  FALSE_IDENTITY_CLAIMS,
  TERMINAL_PROVIDERS,
  ACCESS_COOKIE_NAME,
  escapeHtml,
  localDayKey,
  quotaLimit,
  accessPassword,
  createReplacementOsAccessState,
  authenticateReplacementOsAccess,
  isReplacementOsAuthenticated,
  getReplacementOsQuota,
  consumeReplacementOsQuota,
  loadPersonalMirrorArtifacts,
  recentUserPromptSamples,
  deriveToneProfile,
  summarizeReplacementModel,
  readReplacementOsPublication,
  buildReplacementOsPrompt,
  createFallbackChatResponse,
  getTerminalProviderConfig,
  containsFalseIdentityClaim,
  looksLikeAccessOrSecurityInfoRequest,
  createAccessSecurityBoundaryResponse,
  createServiceStoppedResponse,
  looksLikeRealWorkOrStatusRequest,
  createQaOnlyBoundaryResponse,
  runTerminalModel,
  chatWithReplacementOs,
  renderReplacementOsLoginPage,
  renderReplacementOsPage,
  looksLikeHardConsentAction,
};

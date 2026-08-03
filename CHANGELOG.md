# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.0] - 2026-08-02

### Fixed — LLM 호출 실패·빈 응답에 재시도·복구가 없던 문제 (사용자 피드백)

`callHaiku` 가 실패·빈 응답에서 `''` 를 반환해 호출자가 실패를 인지하지 못했다. 그 배치를
버린 뒤 세션을 완료로 기록했고, 기록된 세션은 pending 에서 영구 제외되므로 **그 대화의
fact 가 다시는 추출되지 않았다**. 재시도 부재가 곧 데이터 손실이었다.

- 유계 재시도(기본 2회, `MEMORY_BANK_LLM_RETRIES`) + 지수 백오프(상한 5s/30s)
- 빈 응답을 `EmptyLlmResponseError` 로 승격 — 실패를 성공(빈 결과)으로 위장하지 않는다
- 실패 3분류(transient/deterministic/unknown)를 단일 소스 모듈로 분리
- deterministic 배치 폐기를 `extraction_log.dropped_batches` 에 dead-letter 로 기록

### Fixed — 추출 파이프라인 정합성 (적대 리뷰 25라운드에서 발견)

- **세션 영구 손실**: 내부 실패에 재시도 예산을 가진 제3 상태(`-4`) 도입. 예산 소진 시
  영구 마커로 승격해 큐가 물리지 않는다
- **훅↔워커 중복 추출**: LLM 호출 전 세션 선점(claim) + 소유권 토큰(`claim_owner`) +
  리스 갱신. fact 삽입과 완료 마커를 **단일 트랜잭션**으로 묶어, 선점을 잃으면 fact 도
  남지 않는다
- **리스 만료 미작동**: ISO-8601 값을 SQLite `datetime()` 출력과 문자 비교해 같은 UTC
  날짜의 만료 claim 이 항상 fresh 로 판정됐다(실효 리스 최대 ~24.5시간) → `datetime()`
  파싱 비교로 수정. 손상 타임스탬프도 회수 대상으로 명시
- **형제 프로젝트 영구 배제**: 제외 목록이 raw prefix 라 `memory-bank` 로 시작하는
  **별개 프로젝트**까지 함께 삼켰다(적격 8세션 영구 미추출) → 경로 경계 매칭으로 수정
- 실패 분류·라우팅·보고를 한 표에서 파생해 "예산은 타는데 재시도된다고 보고" 모순 제거
- pending 판정 사본 제거 — 단일 소스만 사용

### Changed

- `analyze` 의 `coverage.extraction.pending` 이 "로그 행 없는 세션"에서 **"워커가 실제로
  집을 세션"**으로 변경(최소 교환수·제외 프로젝트 필터 포함). `retrying` 지표 추가
- `runFactExtraction` 이 건너뛴 사유(`skipped`)를 반환 — 호출자가 claim 미획득을 정상
  처리와 구분할 수 있다

### Migration

`extraction_log` 에 `dropped_batches`, `claim_owner` 컬럼이 멱등 마이그레이션으로 추가된다
(락 경합 시 다음 초기화에서 재시도).

## [1.4.5] - 2026-07-14

### Added
- **Zero-downtime live plugin updates** — a plugin update now reaches live
  sessions in real time, with no session restart and no manual /reload-plugins
  (stdio MCP servers are officially never auto-reconnected, so v1.4.4's
  "restart required" was the only path until now):
  - `cli/mcp-server-wrapper.js` became a **supervising stdio proxy**
    (`src/wrapper-core.ts`, unit-tested): it records the MCP initialize
    handshake, polls the plugin dir's package.json, and when a new release
    lands on disk it swaps the server child at an idle moment and replays the
    handshake — the client keeps one uninterrupted connection (E2E-tested:
    GEN1→GEN2 over the same pipe, replayed handshake swallowed).
  - `scripts/live-apply.js` propagates the newest release's code into older
    versioned cache dirs (backup first; content-version based; idempotent;
    **node_modules never touched** — dirs with a different dependency set are
    loudly skipped so native binaries stay known-good). Wired into the
    SessionStart drift check, so the first session event after an update
    upgrades every live session's hooks/workers instantly and lets
    supervising wrappers live-swap their servers.
  - Startup-crash rescue: a server that dies within seconds of spawn triggers
    `npm install`, then `npm rebuild` (recompiles broken native binaries) and
    a retry that re-delivers the still-unanswered initialize. Motivated by a
    live incident: the v1.4.4 cache's sharp binary
    (`sharp-darwin-arm64v8.node`) was missing after a fresh cache install, so
    every new MCP server crashed before answering initialize (fixed on this
    machine by transplanting the known-good module; the rescue automates it).

### Fixed
- Worker sweep now judges staleness by the worker dir's **content version**
  (package.json), not the path segment — after live-apply an old-named dir
  carries current code and its workers must not be killed.

## [1.4.4] - 2026-07-14

### Fixed — 플러그인 업데이트 후 구버전 프로세스 잔존 (버전 드리프트)

- sync 싱글톤 락에 `{pid, version, startedAt}` 기록 — 신버전이 구버전·legacy 홀더를
  선점한다. 6시간 이상 wedge 된 홀더는 버전과 무관하게 선점(실측: v1.3.3 sync 가 23시간
  wedge 되어 인덱싱이 하루 동안 동결됐다)
- `sync-cli` 가 시그널 종료 시 락을 해제하지 않던 문제 수정

### Added

- SessionStart hook `scripts/version-drift-check.js` — 구버전 detached 워커 sweep +
  드리프트 경고 주입. MCP 서버는 라이브 세션을 소유하므로 sweep 대상에서 제외


## [1.4.3] - 2026-07-12

### Fixed
- **Ineffective repeat-detection timebox replaced** (found by adversarial
  review): the v1.4.0 `Promise.race` 250ms timebox could never preempt
  `detectRepeat`'s synchronous better-sqlite3 vector search — the timer only
  fires after the blocking call completes. Replaced with an elapsed-budget
  gate: repeat detection is skipped entirely when injection has already spent
  >700ms, which actually bounds tail latency.

## [1.4.2] - 2026-07-12

### Fixed
- **Dependency self-heal**: `claude plugin update` non-deterministically skips
  `npm install` for the new cache dir (observed: 1.4.0 got node_modules,
  1.4.1 did not — every hook then died with `Cannot find package
  'better-sqlite3'`), and cc-sync ships plugin caches to other machines
  WITHOUT node_modules by design. The injection thin client (the only
  dep-free entry point, runs on every prompt) now detects
  ERR_MODULE_NOT_FOUND in its cold fallback and spawns a one-shot detached
  `npm install` in the plugin root, gated by an atomic `wx` marker file so it
  can never loop. Verified in isolation: detect → spawn → marker suppresses
  repeats → better-sqlite3 installed.

## [1.4.1] - 2026-07-12

### Fixed
- **Packaging**: v1.4.0 shipped a stale committed `dist/` (the injection-v2
  build output was not committed with its sources), so fresh installs got the
  new thin client but an old core without the dedup ledger. `dist/` is now
  rebuilt and committed; release checklist gains a HARD check that
  `git status dist/` is clean before tagging.

## [1.4.0] - 2026-07-12

### Added
- **Injection pipeline v2 — session dedup ledger** (`src/inject-ledger.ts`):
  a fact is injected at most ONCE per session. Measured waste before: 74%
  inject rate × 5.5–8 facts × ~140 chars ≈ ~470 tokens/prompt with the SAME
  facts re-injected across a session (~10k tokens per 30-prompt session).
  Ledger is bounded (400 ids, oldest-evict), TTL-pruned (7 days), session-id
  sanitized (path-traversal safe), atomic-write, and fail-open (a corrupt
  ledger never blocks injection). E2E: 2nd call in the same session injects
  0 bytes (`status:deduped`, ~330 tokens saved per repeated prompt).
- **Token budget**: per-fact 160-char truncation + 1,000-char block budget
  (lowest-relevance facts dropped first).
- **Observability**: inject log gains `chars` (block size) and `deduped`
  (facts saved by the ledger) so real-world savings are continuously measured.
- **Knowledge Galaxy** (`ui/relations/`): Three.js 3D visualization of the
  ontology — 32 domains / 4.2k categories / 24.7k facts / 27.8k typed
  relations, with search, per-type edge toggles, relation-navigating detail
  panel, and adaptive performance (compositor-only labels, point-size cap,
  eco-mode DPR degrade).

### Fixed
- `session_id` is now plumbed end-to-end through the injection path
  (hook stdin → thin client → daemon payload → core), which the dedup
  ledger requires.
- `detectRepeat` tail latency bounded (its 313k-exchange vector search has a
  measured p95 of 498ms): the search is synchronous and cannot be preempted
  once started, so it is skipped when injection has already spent >700ms
  (v1.4.0 shipped a Promise.race "timebox" that could not actually preempt
  the sync work — replaced in v1.4.3 with this elapsed-budget gate).
- bench-perf `exchanges_invisible_to_vector_search` counted only
  stale-version rows and reported 0 while ~90k missing-vector rows were
  unsearchable; it now counts true invisibility (stale OR missing vector).
- Vector drain completed: 87,727 invisible exchanges → 0 (all 313k
  exchanges searchable; final baseline: vector p50 20.9ms, fts 3.4ms).

## [1.3.4] - 2026-07-11

### Performance
- **Per-prompt context injection: ~2.3s → ~0.07s (35×)** — the UserPromptSubmit
  hook used to pay a full cold start on EVERY prompt (measured: model load
  1,130ms + node startup ~400ms + imports 186ms; the actual search was ~30ms).
  A warm unix-socket sidecar (`startInjectDaemon`) now lives inside the
  long-lived MCP server (which already has the embedding model loaded); the
  hook is a thin client with a cold local fallback that behaves exactly as
  before when no server is running. No new process, no new lifecycle: the
  sidecar is unref'd and dies with the MCP server; stale sockets are probed
  and reclaimed; socket mode 600. The shell wrapper also went from 4 node
  spawns to 1 (JSON parsing moved into the client), so even the cold fallback
  dropped ~2.3s → ~1.6s.
- **Fact/category vector search: 25.4ms → 3.8ms (6.7×)** — vec_facts /
  vec_facts_kr / vec_categories migrated to int8 (scripts/migrate-vec-facts-int8.mjs),
  same quantization the exchanges index got in v1.3.x. All writers/readers are
  dtype-aware via the new `getVecTableDtype()` (per-table, read from
  sqlite_master — never a flag), with distances normalized BEFORE the
  cross-language-index merge so mixed-dtype states mid-migration stay correct.
  Fresh DBs now create all vec tables as int8. Measured quality: same-id
  distance deviation ≤0.0098 (quantization noise), divergent picks are
  near-ties only.
- Exchanges vector KNN (int8, migrated on-machine via existing
  migrate-vec-int8.mjs): 58.5ms → 13.4ms at equal corpus size.

### Fixed
- **Self-heal for stamp-vector mismatch** — 197K exchanges (53% of one
  production corpus) claimed the current embedding_version but had NO vector
  row, leaving them permanently invisible to semantic search AND to the
  version-only reembed selector. The worker now also selects rows whose
  vec_exchanges row is missing (exact set-diff via the vec0 shadow `_rowids`
  table) and repairs them.
- **Legacy worker-prompt pollution purge + guard** — Haiku worker sessions
  from BEFORE the fixed LLM workdir ran with the caller project cwd, so their
  transcripts were indexed under REAL project slugs (measured: 59,940
  exchanges / ~16% of one corpus) where the v1.3.3 slug exclusion cannot see
  them. `purge-llm-sessions.mjs --legacy-prompts` removes them (backup-first,
  batched transactions), and `isWorkerPromptMessage()` now guards every
  indexing path so re-parsed archives can never re-pollute.
- `sync-import.ts` contained two literal NUL bytes (dedup-key separators) that
  made grep treat the file as BINARY — invisible to every code sweep. Replaced
  with the `\u0000` escape (runtime-identical) and made its vector writes
  dtype-aware.
- `bench-perf.mjs` / `bench/setup-bench-db.mjs`: dtype-aware against int8
  production tables.

### Operations note (per-machine)
Existing installs get the code via plugin update, but the DB-side migrations
run per machine: `node scripts/migrate-vec-int8.mjs` (exchanges),
`node scripts/migrate-vec-facts-int8.mjs` (facts/categories),
`node scripts/purge-llm-sessions.mjs --legacy-prompts --apply` (legacy
pollution), then let the reembed worker drain missing vectors. All are
idempotent, dry-run-first, backup-first.

## [1.3.3] - 2026-07-08

### Fixed
- **LLM worker sessions no longer pollute the conversation index** — every Haiku
  call spawns a one-shot headless CLI session under `<tmpdir>/memory-bank-llm`;
  those transcripts were being indexed like real conversations (measured: 4,351
  sessions / 6.7k exchange rows). `isExcludedProject()` (paths.ts) now built-in
  excludes any project slug ending with `-memory-bank-llm` (current fixed workdir
  and legacy mkdtemp variants alike) and is applied at every exchange-inserting
  walk: `indexConversations` / `indexSession` / `indexUnprocessed` (indexer.ts),
  sync (sync.ts) and verify (verify.ts). Ephemeral worker state is not knowledge.
- **Worker transcripts no longer accumulate forever** — nothing ever deleted the
  one-shot session transcripts (measured: 11,573 files / 99MB under
  `~/.claude/projects/*-memory-bank-llm`). `pruneLlmTranscripts()` (llm.ts) now
  runs opportunistically (throttled to at most hourly) on each LLM call: deletes
  only `.jsonl` / `-summary.txt` files older than a TTL
  (`MEMORY_BANK_LLM_TRANSCRIPT_TTL_HOURS`, default 24h, hard floor 1h so an
  in-flight transcript can never be reaped), strictly inside the reserved
  `*-memory-bank-llm` slug namespace, never following symlinks, removing legacy
  slug dirs once emptied, and never throwing into the LLM call path.
- **Polluted rows cannot become extraction candidates** (defense in depth) —
  `backfill-extract-worker` drops sessions whose `cwd` ends with
  `/memory-bank-llm` from the pending queue, so exchanges indexed before this
  fix cannot feed fact extraction (which would spawn yet more Haiku sessions —
  a self-referential loop). The `NOT IN` subquery filters `session_id IS NOT
  NULL` explicitly: one NULL inside `NOT IN` nulls the whole predicate
  (3-valued logic) and would silently drain the entire backfill.
- **All Agent SDK spawn sites are now contained** — summarizer.ts and
  translate-facts.mjs ran `query()` without `cwd`/`settingSources`, so their
  sessions landed in the caller's project slug (indexable, unpruned) and loaded
  user settings whose SessionStart/End hooks re-spawn sync/backfill workers
  (session cascade). Both now share the same containment as llm.ts `callHaiku`:
  `cwd: llmWorkdir()`, `settingSources: []`.
- `BACKFILL_MIN_EXCHANGES` is validated via `boundedInt` before being
  interpolated into SQL — a garbage value (`'abc'` → `NaN`) used to produce
  invalid query text at runtime.

## [1.3.2] - 2026-07-05

### Fixed
- **`fact-consolidate-worker` had no single-instance lock** — the SessionStart hook
  spawns it detached on every session with no lock, so orphaned workers (ppid=1) piled
  up (measured 14 at once), each spawning a headless Claude session per LLM call and
  flooding the proxy across the account pool. Added a GLOBAL atomic `wx` pid-lock (same
  pattern as the ontology/extract/reembed workers). The lock is global, not per-project,
  because consolidation touches shared global-scope facts — concurrent per-project
  workers would race on the same rows.
- **Consolidation now processes the whole backlog in one pass** (`consolidateAllPending`
  / `getAllNewFactsSince`): the single lock-holder walks every new fact across all
  scopes/projects exactly once under a single Haiku budget, instead of looping
  `consolidateFacts` per project — which re-examined shared global facts once per project
  (up to `MAX_HAIKU_CALLS × projectCount` calls, since INDEPENDENT/CONTRADICTION verdicts
  keep the fact active) and could starve a project whose only pending work was an old
  fact matching a new global one. Same orphan-flood class fixed for the backfill workers
  in v1.3.0; the consolidate worker was the last detached worker missing a lock.
- **Same-scope-only consolidation** (`searchSimilarFactsSameScope`): a fact is compared
  ONLY within its own scope — a project fact against its own project's facts, a global
  fact against other global facts — with the scope gate applied to the full candidate
  overfetch BEFORE truncation, so an in-scope match is never starved out by closer
  out-of-scope rows. This closes a cross-scope data-leak/mutation path in both directions:
  a global driver reaching into a project's private rows, AND a project-private driver
  rewriting a shared global fact via EVOLUTION (leaking private text to every project) or
  deactivating it via CONTRADICTION. The old per-project `consolidateFacts()` (which used
  a project-scoped search that still included globals) was removed — all consolidation
  now goes through the single-pass, scope-isolated `consolidateAllPending`. The
  same-scope search pages the KNN fetch (growing until enough in-scope hits or the
  whole index is scanned) so even >200 closer out-of-scope rows cannot hide a valid
  in-scope match. `consolidateFacts` is kept as a deprecated, now-scope-safe back-compat
  export so existing importers don't crash at module load.
- **Unparseable comparison output is a no-op, not a hard stop**: consolidation is a
  best-effort background dedup, so a comparison whose LLM output isn't valid JSON is
  treated as "no verdict" and the cursor advances past it (the call still counts against
  the per-run Haiku budget). The pair is not lost — both facts stay active and the
  comparison re-triggers whenever either is a driver/candidate later — and no single fact
  (a transient non-JSON response, or a deliberately crafted one) can hold the cursor and
  starve the rest of the backlog. Only TRANSIENT call failures (callHaiku rejected — infra
  down) hold the cursor to retry, which is safe because during an outage nothing else
  would progress either.
- **Keyset consolidation cursor `(created_at, id)`**: the progress cursor was keyed on
  `created_at` alone, which stalled forever when a single timestamp group held more facts
  than the per-run Haiku budget (the cursor couldn't advance into a shared timestamp
  without risking a skip, so every run reprocessed the same oldest N and never reached the
  rest of the backlog). Keying on the unique `(created_at, id)` pair lets the drain advance
  one fact at a time — no stall, no same-timestamp skip. The cursor is persisted as JSON;
  an absent/legacy/corrupt cursor makes the drain start from the BEGINNING (no active fact
  is skipped — the per-run budget only caps actual consolidation calls, so the whole
  backlog drains across a few runs regardless of age). A fact imported mid-drain with an
  old timestamp is not re-driven by the current pass but is still a candidate for future
  comparisons (best-effort dedup, documented).
- **Bounded drain page + index**: the consolidation query pages the keyset (LIMIT 2000)
  instead of materializing every active fact, and a new `idx_facts_active_created_id`
  index serves the `(is_active, created_at, id)` filter+sort — so a from-the-beginning
  drain over tens of thousands of facts can't OOM or trigger a full-table temp sort.
- **Error-classified consolidation failure handling** (`classifyLlmError`): a comparison
  CALL rejection is three-valued — TRANSIENT (429/5xx/timeout/network/auth), DETERMINISTIC
  (400/413/422/oversized-prompt), or UNKNOWN (unrecognized). The status is read from the
  structured error (`status`/`statusCode`) OR the nested SDK/axios shape
  (`error.response.status`) OR a status number explicitly labelled in the message
  ("status code 400") — never a bare incidental number ("retry after 400 ms"). The drain
  loop SKIPS (advances after `facts.consolidation_attempts` reaches MAX, idempotent
  migration) **only** on a recognized DETERMINISTIC rejection — the one case where the fact
  itself is provably at fault. TRANSIENT, UNKNOWN, and any non-LLM internal error
  (parser/DB bug, tagged apart via `LlmCallError`) all HOLD the cursor and retry — an
  outage or an unrecognized error never silently drains the backlog, and a code bug never
  gets miscounted as a "bad fact". Skipping only on a certain per-request rejection is the
  narrowest, safest criterion that satisfies both "an outage must not silently drain the
  backlog" and "one un-processable fact must not wedge the cursor".
- **Persisted consolidation cursor**: the worker records the last fully-examined
  `created_at` (`fact-consolidate-cursor.txt`) and resumes after it, so the single Haiku
  budget reaches newer/project backlog instead of re-spending every run on the same
  oldest INDEPENDENT facts. The cursor only advances past a timestamp strictly older than
  the first unexamined fact, so same-millisecond facts at the budget wall are never
  skipped; a fact whose comparison errors (transient LLM failure) also holds the cursor
  back so it is retried, not permanently skipped.

## [1.3.1] - 2026-07-05

### Documentation
- **README**: "What's New" refreshed for v1.3.0 (batch classification, spawn isolation,
  attempt ledger, vec-index self-heal, hardened worker caps) and new **Configuration**
  entries for the backfill worker env knobs (`BACKFILL_ONTOLOGY_MAX`, `BACKFILL_EXTRACT_MAX`,
  `BACKFILL_BATCH_SIZE`, `BACKFILL_CONCURRENCY`, `BACKFILL_RELATIONS`) and the opt-in
  deterministic reuse gate (`MEMORY_BANK_ONTOLOGY_DET_GATE`, disabled by default per
  live measurement)

## [1.3.0] - 2026-07-05

### Changed
- **Ontology backfill batching**: `backfill-ontology-worker` now classifies facts in
  batches (default 20 per LLM call, `BACKFILL_BATCH_SIZE` env, ceiling 50) — one
  headless Agent SDK spawn per batch instead of per fact. Measured on live data:
  40 facts in 19s vs ~8min with per-fact calls (~25× wall-clock, 20× fewer spawns).
- **Headless LLM spawn isolation** (`llm.ts`): Agent SDK sessions now run with
  `maxTurns: 1`, `settingSources: []`, and a dedicated tmp `cwd` — worker LLM calls
  no longer fire user SessionStart/End hooks (which re-spawned sync/backfill workers
  per call) and no longer drop transcripts into user project dirs (where
  `claude --resume` could pick up a worker session).
- **Backfill relation detection defaults OFF** (`BACKFILL_RELATIONS=1` to opt in):
  each relation probe costs an extra LLM call; insert-time detection is unchanged.

### Added
- **Ontology attempt ledger** (`facts.ontology_attempts` / `ontology_last_attempt_at`,
  idempotent migration): failed classifications are counted per fact; after
  3 attempts the fact is parked in General/Misc and permanently leaves the backfill
  queue (it stays fully searchable — ontology is an overlay). Ends the
  re-select-and-re-bill-forever loop for permanently failing facts.
- `scripts/measure-det-gate.mjs` — live-data measurement harness for the
  deterministic category-reuse gate. The gate ships DISABLED by default
  (opt-in via `MEMORY_BANK_ONTOLOGY_DET_GATE`): measured top-1 agreement with LLM
  assignments was only 72% at sim≥0.93 (n=800 sample) — insufficient for auto-assign.

### Hardened (adversarial review, 24 rounds pre-release)
- Single-fact classification path unified onto the batch core (structured JSON prompt,
  index validation, typed failure taxonomy shared)
- Transient circuit breaker in the backfill worker (consecutive all-transient batches
  abort the run; facts preserved untouched)
- Category vec-index self-heal: exact id set-diff trigger, bidirectional reconciliation
  (add missing + purge stale), structured completeness reporting — an incomplete index
  always refuses candidate-starved classification
- `IndexRepairError` typed escalation: index corruption surfaces loudly, never burns
  fact attempts, never blocks relation detection over the healthy fact index
- Relation edges idempotent per (source, type, target) + UNIQUE index migration
  (exact-triple dedup only — distinct relation types between the same facts are
  preserved as valid graph data)
- Graph traversal: deterministic belief-safety edge preference (CONTRADICTS >
  SUPERSEDES > affirmative), qualifying-edge fallback, and pruned-path containment

### Fixed
- **Fallback classification was never persisted**: on unparseable LLM output the
  classifier built General/Misc but returned without writing the fact's
  `ontology_category_id`, leaving it NULL — re-selected (and re-billed) by every
  backfill run. Classification failure now raises, feeds the attempt ledger, and
  the fallback is actually persisted at the attempt cap.
- **Honest failure counts** in the backfill log: errors were swallowed inside
  `classifyAndLinkFact`, so the log always reported `failed 0`. The batch pipeline
  reports llm/deterministic/fallback/failed separately.

## [1.2.2] - 2026-07-04

### Documentation
- **README**: "What's New" refreshed for v1.2.x, new **Context Injection** section
  (per-prompt injection pipeline, baseline-margin relevance gate, 1-hop ontology
  expansion, observability log locations, troubleshooting), Context Injection
  added to the feature list and data-flow diagram.

## [1.2.1] - 2026-07-04

### Added
- **Injection observability (fail-loud)**: the UserPromptSubmit context-injection
  pipeline now records every run as a JSONL entry
  (`<config>/conversation-index/logs/inject-context.jsonl` — status
  injected/no-match/skipped/error, candidate/injected counts, duration), and the
  hook wrapper routes node-level crash output to `logs/inject-context.err.log`
  instead of discarding it. A silently broken install (stale plugin, missing
  `node_modules`) is now measurable instead of invisible — the previous
  silent-failure mode went unnoticed for months.

### Fixed
- Injection error paths now log the failure reason (truncated to 300 chars)
  alongside the existing stderr message.

## [1.2.0] - 2026-07-03

### Added
- **`memory-bank analyze` command**: Deterministic full-history analysis of the entire
  conversation index — coverage (fact extraction / summaries), fact breakdowns by
  category/scope, top knowledge domains, per-project rollups, monthly activity
  timeline, and backfill recommendations. Supports `--json`, `--out`, `--top`, `--months`.
- **`analyzing-all-conversations` skill**: Plugin skill that runs the analyze engine,
  kicks off backfill for unanalyzed sessions, enriches the numbers with fact/ontology
  search, and presents an organized report of the whole conversation history.
- **Transparent `.zst` archive support** (`src/archive-io.ts`): The conversation archive
  may be compressed out-of-band (`*.jsonl` → `*.jsonl.zst`). All read paths — parser,
  `read` MCP tool, search summaries/line counts, sync, stats, indexer, verify — now
  resolve either variant using Node's built-in zstd (Node >= 22.15), no new dependency.

### Changed
- **FTS5 text search**: BM25-ranked full-text search (`exchanges_fts`, detail=column) replaces
  the O(rows) LIKE full scan — recall@10 0.93 → 1.00, FTS index 2,953MB → 407MB. Query
  tokenization aligned with the unicode61 tokenizer; identifier tokens preserved; rank
  budget + sparse-token AND ladder to avoid BM25 pathologies.
- **Search-path performance**: cached search DB connection (path-keyed, mtime-checked),
  int8 vector quantization for `vec_exchanges` (dual-dtype with migration), and
  query-embedding LRU memoization (removes double embedding per MCP search).
- **Backfill extraction guards**: self-referential projects excluded by default
  (`BACKFILL_EXCLUDE_PROJECTS`) and minimum-exchange filter to skip empty sessions.
- **Fact extraction quality/cost improvements**:
  - Trivial exchanges (bare slash commands, harness artifacts, short acknowledgements)
    are filtered before LLM calls.
  - Cross-batch duplicate facts within a session are dropped via normalized comparison.
  - Long sessions cap LLM calls (default 12, `MEMORY_BANK_MAX_EXTRACT_CALLS`) with
    evenly-spread batch selection so the whole session is represented.
  - Extraction prompt now prefers durable facts and problem→solution lessons.
- **Sync no longer re-copies archives compressed out-of-band**: `copyIfNewer` treats a
  current `.zst` copy as up-to-date, preventing full-history re-copy churn each session.

### Fixed
- **`read` MCP tool worked only on plain `.jsonl`**: reading any archived conversation
  failed with "File not found" once the archive was compressed. Now resolves `.zst`.
- **Summary coverage was misreported as zero**: existing `-summary.txt.zst` files are
  now detected by stats/analyze/sync/indexer/verify.

## [1.1.0] - 2026-04-12

### Added
- **Multi coding-agent tagging**: Conversations and extracted facts now record which coding agent produced them.
  - Default source remains `claude-code`.
  - Additional sources can be configured with `MEMORY_BANK_AGENT_SOURCES` or `conversation-index/agent-sources.json`.
  - Supported agent labels include `claude-code`, `codex`, `opencode`, and custom agent names.
- **Agent-aware search filters**: MCP and library search paths can filter conversations and facts by `coding_agent`.
  - `search` supports a `coding_agent` filter.
  - `search_facts` supports a `coding_agent` filter.
  - Search result formatting shows an agent tag for non-default sources.

### Changed
- **Sync now preserves source-agent identity**: Synced exchanges are tagged during indexing so multi-agent setups can share one memory bank without losing provenance.
- **Search agent upgraded to Sonnet**: The bundled `search-conversations` agent now uses Sonnet instead of Haiku for stronger retrieval and synthesis.
- **Plugin update docs clarified**: README update instructions now use the correct `/plugin update memory-bank` command.

### Fixed
- **Facts inherit coding-agent metadata**: Fact extraction now carries the exchange agent through to saved facts.
- **Search and fact schema migrations are backward-compatible**: Existing databases gain the new `coding_agent` columns through idempotent migrations.

## [1.0.16] - 2026-03-25

### Added
- **`/show-memory-bank` slash command**: Opens the Memory Bank web dashboard from Claude Code.
- **Automatic command installation**: SessionStart hooks install bundled slash commands into user scope.

### Changed
- **Plugin command manifest format**: `commands` now points to the commands directory so Claude Code can discover bundled commands correctly.

## [1.0.15] - 2025-12-17

### Changed
- **Stop shipping package-lock.json**: Removed from git tracking so npm generates platform-appropriate lockfile on install
- **Remove file deletion from MCP wrapper**: No longer deletes package-lock.json on first run (unnecessary without shipped lockfile)

## [1.0.14] - 2025-12-16

### Fixed
- **Windows spawn ENOENT error**: Add `shell` option for npx commands on Windows (#36, thanks @andrewcchoi!)
  - On Windows, npx is a .cmd file requiring `shell: true` for spawn() to work
  - Applied fix to `cli/memory-bank.js` and `cli/index-conversations.js`
  - Resolves plugin initialization failures and silent SessionStart hook failures on Windows
- **Agent conversations polluting search index**: Add exclusion marker to summarizer prompts (#15, thanks @one1zero1one!)
  - Summarizer agent conversations are now properly excluded from indexing
  - Extracted marker to shared constant (`SUMMARIZER_CONTEXT_MARKER`) for maintainability
- **Background sync silently failing**: CLI now uses compiled JS instead of tsx at runtime (#25 root cause, thanks @stromseth for identifying!)
  - `--background` flag on sync command now works correctly
  - Fixes SessionStart hook auto-sync that was silently failing
- **Directory auto-creation**: Config directories are now created automatically (inspired by #18, thanks @gingerbeardman!)
  - `getSuperpowersDir()`, `getArchiveDir()`, `getIndexDir()` now ensure directories exist
  - Prevents errors on fresh installs where directories don't exist yet

### Changed
- **CLI uses compiled JavaScript**: Remove tsx from runtime path
  - All CLI commands now route through `dist/*.js` instead of `npx tsx src/*.ts`
  - Faster startup, lighter runtime dependencies
  - tsx is now dev-only (for tests and development)
  - Obsoletes PR #25 (background sync fix) by fixing root cause
- **CLI architecture cleanup**: Replace bash scripts with Node.js wrappers
  - All CLI entry points (`memory-bank`, `index-conversations`, `search-conversations`, `mcp-server`) are now Node.js scripts
  - Eliminates bash dependency entirely for full cross-platform support (Windows, NixOS, etc.)
  - SessionStart hook now calls `node cli/memory-bank.js` directly
  - Added `search-conversations.js` to complete Node.js CLI coverage
  - Obsoletes PRs #29 (pnpm workspace), #11 (env bash), and #17 (shebang fix)

## [1.0.13] - 2025-11-22

### Fixed
- **MCP server startup error**: Fix "Invalid or unexpected token" error when starting MCP server
  - Changed plugin.json to use `cli/mcp-server-wrapper.js` instead of bash script `cli/mcp-server`
  - MCP server configuration was pointing to bash script which was being executed with `node` command
  - Wrapper script properly handles Node.js execution and runs bundled `dist/mcp-server.js`

## [1.0.12] - 2025-11-22

### Changed
- **Skill triggering behavior**: Improved memory bank skill to trigger at appropriate times
  - Changed from "ALWAYS USE THIS SKILL WHEN STARTING ANY KIND OF WORK" to contextual triggers
  - Now triggers when user asks for approach/decision after exploring code
  - Now triggers when stuck on complex problems after investigating
  - Now triggers for unfamiliar workflows or explicit historical references
  - Prevents premature memory searches before understanding current codebase
  - Empirically tested with subagents: 5/5 scenarios passed vs 3/5 with previous description

## [1.0.11] - 2025-11-20

### Fixed
- **Plugin Configuration**: Fix duplicate hooks file error in Claude Code
  - Remove duplicate `"hooks": "./hooks/hooks.json"` reference from plugin.json
  - Claude Code automatically loads hooks/hooks.json, so manifest should only reference additional hook files
  - Update MCP server reference from obsolete `mcp-server-wrapper.js` to direct `mcp-server` script

### Changed
- Simplified plugin.json configuration for cleaner Claude Code integration

## [1.0.10] - 2025-11-20

### Fixed
- **Search result formatting**: Prevent Claude's Read tool 256KB limit failures
  - Search results now include file metadata (size in KB, total line count)
  - Changed from verbose 3-line format to clean 1-line: "Lines 10-25 in /path/file.jsonl (295.7KB, 1247 lines)"
  - Removes prescriptive MCP tool instructions, trusting Claude to choose correct tool based on file size
  - Eliminates issue where memory bank search triggered built-in Read tool instead of specialized MCP read tool

### Changed
- Enhanced `formatResults()` and `formatMultiConceptResults()` with async file metadata collection
- Added efficient streaming line counting and file size utilities
- Updated MCP server and CLI callers to handle async formatting functions

## [1.0.9] - 2025-10-31

### Removed
- **Dead code cleanup**: Removed obsolete bash script `cli/mcp-server-wrapper`
  - Eliminates duplicate wrapper implementations
  - Only Node.js cross-platform wrapper `mcp-server-wrapper.js` remains
  - Prevents confusion about which wrapper to use
  - Cleaner codebase with single MCP server entry point

### Changed
- Simplified MCP server architecture with single wrapper implementation
- Improved maintainability by removing redundant bash script

## [1.0.8] - 2025-10-31

### Fixed
- **Issue #7**: Fixed Windows support for MCP server provided in plugin
  - Replaced bash script `mcp-server-wrapper` with cross-platform Node.js version
  - MCP server now works on Windows with Claude Code native install
  - Resolves "No such file or directory" errors on Windows when using `/bin/bash`

### Changed
- MCP server wrapper now uses `node cli/mcp-server-wrapper.js` instead of bash script
- Cross-platform dependency installation with proper Windows npm.cmd handling
- Improved signal forwarding and process management in wrapper

### Added
- Cross-platform Node.js wrapper script for MCP server initialization
- Better error handling and messaging for missing dependencies
- Windows-compatible npm command detection (`npm.cmd` vs `npm`)

## [1.0.7] - 2025-10-31

### Fixed
- **Issue #10**: Fixed SessionStart hook configuration that prevented memory sync from running
  - Removed invalid `args` property from hook configuration
  - Added `async: true` and `--background` flag to prevent blocking Claude startup
- **Issue #5**: Fixed summary generation failure during sync command
  - Resolved confusion between archived conversation IDs and active session IDs
  - Sync now properly generates summaries for archived conversations
- **Issue #9**: Fixed better-sqlite3 Node.js version compatibility issues
  - Added postinstall script to automatically rebuild native modules
  - Resolves NODE_MODULE_VERSION mismatch errors on Node.js v25+
- **Issue #8**: Fixed version mismatch between git tags and marketplace.json
  - Synchronized plugin version metadata with release tags

### Added
- Background sync mode with `--background` flag for non-blocking operation
- Automatic native module rebuilding for cross-Node.js version compatibility
- Enhanced CLI help documentation with background mode usage examples

### Changed
- SessionStart hook now uses `memory-bank sync --background` for instant startup
- Sync command forks to background process when `--background` flag is used
- Improved hook configuration follows Claude Code hook specification exactly
- Updated marketplace.json versions in both embedded and superpowers-marketplace locations

### Security
- Fixed potential process blocking during Claude Code startup
- Improved process detachment for background operations

## [1.0.6] - 2025-10-27

### Fixed
- **Issue #1**: Fixed Windows CLI execution failure by replacing bash scripts with cross-platform Node.js implementation
- **Issue #4**: Fixed sqlite-vec extension loading error on macOS ARM64 and Linux by adding `--external:sqlite-vec` to esbuild configuration
- Resolved "Loadable extension for sqlite-vec not found" error on affected platforms

### Added
- Cross-platform CLI support using Node.js instead of bash scripts
- Enhanced error handling with clear error messages and troubleshooting guidance
- Automatic dependency validation (npx, tsx) in CLI tools
- Proper symlink resolution for npm link and global installations

### Changed
- CLI entry points now use `.js` extension for universal compatibility
- Replaced `shell: true` spawn calls with direct spawn for improved security
- Updated build configuration to externalize sqlite-vec native module
- Improved process execution without shell interpretation to prevent command injection

### Security
- Removed shell dependencies from CLI execution
- Added input validation and protection against command injection vulnerabilities
- Safer process execution using direct spawn calls

## [1.0.5] - 2025-10-25

### Fixed
- MCP server wrapper now deletes package-lock.json before npm install to ensure platform-specific sqlite-vec packages are installed
- Resolves "Loadable extension for sqlite-vec not found" error on fresh plugin installs

### Changed
- Add package-lock.json to .gitignore to prevent cross-platform optional dependency issues
- Improve wrapper script to handle npm's platform-specific optional dependency installation behavior

## [1.0.4] - 2025-10-23

### Changed
- Strengthen agent and MCP tool descriptions to emphasize memory restoration
- Use empowering "this restores it" framing instead of deficit-focused language
- Make it crystal clear the tool provides cross-session memory and should be used before every task

## [1.0.3] - 2025-10-23

### Fixed
- MCP server now automatically installs npm dependencies on first startup via wrapper script
- Resolves "Cannot find module" errors for @modelcontextprotocol/sdk and native dependencies

### Added
- MCP server wrapper script (`cli/mcp-server-wrapper`) that auto-installs dependencies before starting
- esbuild bundling for MCP server to reduce dependency load time

### Changed
- MCP server now uses wrapper script instead of direct node execution
- Removed SessionStart ensure-dependencies hook (no longer needed)

### Removed
- `cli/ensure-dependencies` script (replaced by MCP server wrapper)

## [1.0.2] - 2025-10-23

### Fixed
- Pre-build and commit dist/ directory to avoid MCP server startup errors
- Remove dist/ from .gitignore to ensure built files are available after plugin install

### Changed
- Built JavaScript files now tracked in git for immediate plugin availability

## [1.0.1] - 2025-10-23

### Added
- Automatic dependency installation on plugin install via SessionStart hook
- `ensure-dependencies` script that checks and installs npm dependencies when needed

### Changed
- Plugin installation now automatically runs `npm install` if `node_modules` is missing
- Improved first-time plugin installation experience

### Fixed
- Plugin dependencies not being installed automatically after plugin installation

## [1.0.0] - 2025-10-14

### Added
- Initial release of memory-bank
- Semantic search for Claude Code conversations
- MCP server integration for Claude Code
- Automatic session-end indexing via plugin hooks
- Multi-concept AND search for finding conversations matching all terms
- Unified CLI with commands: sync, search, show, stats, index
- Support for excluding conversations from indexing via DO NOT INDEX marker
- Comprehensive metadata tracking (session ID, git branch, thinking level, etc.)
- Both vector (semantic) and text (exact match) search modes
- Conversation display with markdown and HTML output formats
- Database verification and repair tools
- Full test suite with 71 tests

### Features
- **Search Modes**: Vector search, text search, or combined
- **Automatic Indexing**: SessionStart hook runs sync automatically
- **Privacy**: Exclude sensitive conversations from search index
- **Offline**: Uses local Transformers.js for embeddings (no API calls)
- **Fast**: SQLite with sqlite-vec for efficient similarity search
- **Rich Metadata**: Tracks project, date, git branch, Claude version, and more

### Components
- Core TypeScript library for indexing and searching
- CLI tools for manual operations
- MCP server for Claude Code integration
- Automatic search agent that triggers on relevant queries
- SessionStart hook for dependency installation and sync

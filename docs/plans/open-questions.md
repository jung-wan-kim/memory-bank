# Open Questions

## 2026-10-19 Memorilla 적용 (`docs/plans/2026-10-19-memorilla-applicability.md`)

- [ ] C4 facts FTS(trigram 또는 구 질의) 도입. 졸업 트리거: 재생 판정의 kw 변형이 판정2 줄 Δ 구간 하한 > 0 이고 우회 패턴 선택 0 → 사용자가 10.5GB DB 스키마 이행 승인. (2026-10-19 측정: Δ +0.003 [0, 0.010] — 미충족)
- [ ] C6 SessionStart 크기 결정 규칙. 졸업 트리거: `via:'session-start'` 줄이 세션 50개 이상 → 같은 scope 무작위 대조군 대비 적중률 계획.
- [ ] 가족 scope 를 `getTopFacts`(SessionStart)에 적용. 졸업 트리거: C6 로그 50세션 → 별도 측정.
- [ ] 가족 scope 쓰기 쪽 정규화(새 사실 scope_project 를 주 루트로). 졸업 트리거: 지워진 worktree 고아 사실 수 실측 후 이행 계획.
- [ ] 가족 scope 의 일반화. 2026-10-19 판정의 판정 2 이득 16줄은 전부 한 저장소(본체와 연결 worktree)에서 나왔고, 다른 저장소 3곳의 영향 프롬프트 22개는 이득 0·30개 미만이라 따로 판정하지 못했다. 졸업 트리거: 그 저장소 밖 영향 프롬프트가 30개 이상 쌓임 → 같은 규칙으로 그 부분집합만 다시 판정(유지 조건 미달이면 운영 값 재검토).
- [ ] 긴 프롬프트의 붙여 넣은 블록 제거 질의(C7 대체안). 졸업 트리거: 사람이 친 긴 프롬프트의 하드 부분집합 손실 확인.
- [ ] 관계 확장 재설계. 졸업 트리거: 관계 줄 판정≥1 51.7% 를 올릴 다른 방식(예: 이웃의 관계 유형별 가중, 확장 seed 수)을 재생 판정으로 비교할 계획.
- [ ] 저장소 밖에 놓인 worktree 의 가족. 여러 저장소의 worktree 를 한 상위 폴더(`<umbrella>/.auto-issue-worktrees/<ORG>-<REPO>/issue-N`)에 두는 배치에서는 worktree 세션이 본 저장소 사실만 보고 같은 저장소의 형제 worktree 사실은 보지 못하며, 지워진 그런 worktree 는 재생에서 가족이 없다. 졸업 트리거: 본 저장소의 `.git/worktrees/*/gitdir` 로 형제 worktree 를 열거하는 방식의 재생 판정 계획(지워진 worktree 의 소속을 남길 기록이 먼저 필요).

## 2026-11-02 네이티브 inject 클라이언트 (`docs/plans/2026-11-02-native-inject-client.md`)

- [ ] 라이브 search_ms p50 246ms(격리 17ms) 의 원인 확정 — 프롬프트 제출 순간의 훅 다발 CPU 경합 가설. 졸업 트리거: 1.7.9 라이브 로그 1주 뒤 `client_impl=native` 줄의 search_ms 분포가 그대로면(≥200ms) 데몬 안 측정 보강(`process.cpuUsage` 전/후·동시 프로세스 수)으로 재진단.
- [ ] 사실 벡터 표 int8@600 이행(2026-10-16 계획 7단계) — 지금도 float32(37+31MB). 가드가 1.7.6 프로세스(아직 실행 중)를 거부한다. 졸업 트리거: 옛 세션 종료 뒤 `scripts/migrate-vec-facts-int8.mjs` 실행 결정.
- [ ] 다른 플랫폼(linux-x64 등) 프리빌트 배포 여부. 졸업 트리거: cargo 없는 사용자의 요청 또는 GitHub Release 자산 빌드 파이프라인 결정.

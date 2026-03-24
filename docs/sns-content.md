# Memory Bank — Knowledge Graph SNS Content

---

## Twitter/X (English)

### Thread (1/4)

```
I built a Knowledge Graph system for Claude Code conversations.

Instead of just searching past chats, it now:
- Extracts facts with LLM
- Classifies into ontology (Domain → Category)
- Detects relations (INFLUENCES, SUPPORTS, CONTRADICTS)
- Enables multi-hop graph traversal

Open source: github.com/jung-wan-kim/memory-bank
```

### Thread (2/4)

```
The data pipeline has 4 layers:

▲ Prompt Input → conversations, tool calls, JSONL archive
◎ User Scope → global preferences & decisions
● Project Scope → 37 projects clustered by domain
◇ Ontology → auto-classified domains & categories

All connected by typed relations flowing upward.
```

### Thread (3/4)

```
New MCP tools added:

🔍 search — now with RAG context (related facts auto-attached)
🔗 trace_fact — trace any fact back to its source conversation
🌐 cross_project_insights — find similar decisions from OTHER projects
🕸️ explore_graph — multi-hop traversal up to 3 hops deep
📊 graph_stats — knowledge graph health monitoring

5→9 MCP tools, 109→115 tests, 6/6 experiments KEEP
```

### Thread (4/4)

```
The 3D visualization shows the actual data:
- 36,018 conversation exchanges
- 37 projects, 7 domains
- Neon nodes with sparkle trails
- Data flow particles between layers
- Interactive: drag, zoom, layer toggle

Try it: [screenshot]
```

---

## Twitter/X (Korean)

### Thread (1/3)

```
Claude Code 대화를 단순 검색이 아니라 지식그래프로 구축하는 플러그인을 만들었습니다.

대화 → Fact 추출 → 온톨로지 분류 → 관계 탐지 → 멀티홉 탐색

프로젝트 간 지식 전이까지 가능합니다.

github.com/jung-wan-kim/memory-bank
```

### Thread (2/3)

```
4단계 데이터 플로우:

▲ Prompt Input — 대화/도구호출/세션
◎ User Scope — 전역 선호/결정/패턴
● Project Scope — 프로젝트별 클러스터
◇ Ontology — 도메인/카테고리 자동 분류

실제 DB 데이터 36,018 exchanges 기반 3D 시각화까지.
```

### Thread (3/3)

```
새로 추가된 MCP 도구들:

• trace_fact — fact의 출처 대화 역추적
• cross_project_insights — 다른 프로젝트의 유사 결정 조회
• explore_graph — 3-hop 그래프 탐색
• graph_stats — 지식그래프 통계

6번 실험 전부 KEEP, 테스트 109→115개 통과 ✅
```

---

## LinkedIn

```
🧠 Building a Knowledge Graph from AI Conversations

I've been working on Memory Bank, an open-source Claude Code plugin that transforms conversation history into a structured knowledge graph.

The Problem:
Every Claude Code session starts from scratch. Past decisions, architectural choices, and debugging solutions are lost in thousands of JSONL files.

The Solution:
Instead of simple keyword search, Memory Bank now builds a multi-layered knowledge graph:

1. Prompt Input — Conversations are parsed and archived
2. User Scope — LLM extracts facts (decisions, preferences, patterns)
3. Project Scope — Facts are scoped and clustered by project
4. Ontology — Auto-classified into domains and categories with typed relations

Key capabilities:
→ RAG-enhanced search (facts auto-attached to results)
→ Fact provenance tracing (any fact → source conversation)
→ Cross-project knowledge transfer
→ Multi-hop graph traversal (up to 3 hops)
→ 3D visualization with data flow animation

Built with:
TypeScript, SQLite + sqlite-vec (384-dim embeddings), MCP protocol, Haiku LLM for extraction

The 3D visualization renders actual production data: 36,018 exchanges across 37 projects, with neon-style nodes and animated data flow particles.

All experiments verified: 6/6 KEEP, 115 tests passing.

🔗 github.com/jung-wan-kim/memory-bank

#ClaudeCode #KnowledgeGraph #RAG #AI #OpenSource #MCP
```

---

## 한국 개발자 커뮤니티 (GeekNews / 디스코드 / 카카오)

```
[오픈소스] Claude Code 대화를 지식그래프로 구축하는 플러그인

Claude Code로 개발하면 대화 기록이 수만 개 쌓이는데, 매번 새 세션마다 같은 결정을 다시 내리게 됩니다.

Memory Bank는 이 대화들을 분석해서:

📥 Prompt Input
  사용자 메시지, 도구 호출, 응답을 JSONL로 아카이빙

🔤 User Scope
  LLM(Haiku)이 결정/선호/패턴을 자동 추출 → 전역 팩트

📂 Project Scope
  프로젝트별로 팩트를 스코핑하고 클러스터링

🧬 Ontology
  도메인→카테고리 자동 분류 + 관계 탐지
  (INFLUENCES, SUPPORTS, SUPERSEDES, CONTRADICTS)

실용적인 기능들:
- search가 관련 팩트를 자동으로 붙여서 RAG처럼 동작
- trace_fact로 "왜 이렇게 결정했지?" 원본 대화 복원
- cross_project_insights로 다른 프로젝트 결정 참고
- explore_graph로 A→B→C 연쇄 영향 추적

3D 시각화 (실제 데이터):
- 36,018 exchanges, 37 프로젝트
- 네온 노드 + 반짝임 잔상 + 데이터 플로우 파티클
- 4개 레이어 그리드 분리 + 카메라 자동 orbit

스택: TypeScript, SQLite+sqlite-vec, MCP, Haiku
테스트: 115개 통과, 실험 6/6 KEEP

GitHub: github.com/jung-wan-kim/memory-bank
```

---

## 이미지 가이드

| 용도 | 파일 | 설명 |
|------|------|------|
| 메인 이미지 | `docs/graph-3d-screenshot.png` | 4레이어 전체 조감 |
| 보조 이미지 | `docs/graph-3d-screenshot-2.png` | 다른 각도 (회전 후) |
| 영상 | `video/knowledge-graph/out/knowledge-graph.mp4` | 30초 Remotion 영상 |
| 요약 HTML | `docs/knowledge-graph.html` | 정적 요약 페이지 |
| 인터랙티브 | `docs/graph-3d.html` | 3D 인터랙티브 (로컬 실행) |

### 추천 구성

- **Twitter**: 스크린샷 2장 + 텍스트 스레드
- **LinkedIn**: 스크린샷 1장 + 장문 포스트
- **한국 커뮤니티**: 스크린샷 + GIF (graph-3d.html 녹화) + 텍스트
- **YouTube/Shorts**: knowledge-graph.mp4 (30초)

# 태그 가이드 — memory-bank의 데이터를 내 방식대로 묶기

memory-bank는 대화에서 fact를 자동 추출하고, 자동으로 분류하고, 자동으로 통합합니다. 이 자동화가 잘 돌수록 생기는 질문이 있습니다.

> "내가 원하는 기준으로 묶고 싶은데, 어디를 만져야 하나요?"

답은 **태그**입니다. 이 문서는 memory-bank의 라벨링 축이 몇 개이고, 그중 무엇이 사용자 것인지, 그걸로 무엇을 할 수 있는지를 설명합니다.

---

## 1. 라벨링 축은 5개, 그중 사용자가 만지는 건 1개

fact 하나에는 다섯 종류의 라벨이 붙습니다.

| 축 | 누가 정하나 | 값 | 사용자가 바꿀 수 있나 |
|---|---|---|---|
| `scope_type` | 자동 (LLM 판단) | `project` / `global` **2종 고정** | ✗ |
| `category` | 자동 (LLM 판단) | `decision` `preference` `pattern` `knowledge` `constraint` **5종 고정** | ✗ |
| `coding_agent` | 자동 (실행 환경) | `claude-code` / `codex` / `opencode` … | ✗ |
| 온톨로지 `domain/category` | 자동 (LLM 생성) | 자유 문자열 (현재 30+ 도메인, 4천+ 카테고리) | ✗ (직접 지정 불가) |
| **`tags`** | **사용자** | **자유 문자열** | **✓** |

앞의 네 축은 전부 자동입니다. 잘 동작하지만 **내 의도를 넣을 자리가 없습니다.** 온톨로지는 자유롭게 생성되긴 하나 LLM이 정하므로, "이 fact를 내가 만든 `검증완료` 그룹에 넣겠다"는 표현이 불가능합니다.

태그는 그 자리를 채웁니다. 그리고 중요한 성질이 하나 있습니다:

> **자동 파이프라인(추출·통합·온톨로지 분류·재임베딩)은 `tags` 컬럼을 절대 쓰지 않습니다.**

즉 fact 내용이 통합으로 바뀌어도, 온톨로지가 재분류돼도, 임베딩 모델이 교체돼도 **내가 붙인 태그는 그대로 남습니다.** 태그는 자동화가 침범하지 않는 사용자 영역입니다.

---

## 2. 30초 사용법

```bash
# 1) fact id 찾기 — 검색 결과에 ID가 표시됩니다
memory-bank search "인증 방식"

# 2) 태그 붙이기
memory-bank tag <fact-id> verified 결제

# 3) 태그로 다시 찾기
memory-bank tags                      # 태그 인덱스 (태그 → fact 수)
memory-bank tags --find verified      # 이 태그가 붙은 fact 전부
```

Claude Code 대화 중에는 MCP 도구로 그대로 됩니다.

```
search_facts(query: "인증 방식")        → 결과에 ID와 Tags 표시
tag_fact(fact_id: "...", add: ["verified"])
list_tags()                            → 태그 인덱스
list_tags(tags: ["verified"])          → 해당 fact 목록
search_facts(query: "...", tags: ["verified"])   → 검색 + 태그 필터
```

---

## 3. 이럴 때 쓰면 됩니다

### 3-1. 신뢰도 레이어 나누기 (raw / verified)

자동 추출된 fact는 전부 같은 취급을 받습니다. 사람이 확인한 것과 아닌 것을 구분하고 싶다면 태그가 그 레이어가 됩니다.

```bash
memory-bank tag <fact-id> verified          # 사람이 확인함
memory-bank tag <fact-id> needs-check       # 의심스러움
memory-bank tags --find verified            # 검증된 것만 보기
```

`consolidated_count`(같은 내용이 몇 번 재확인됐는지)가 자동 신뢰도 신호로 이미 있지만, 그건 "여러 번 나왔다"이지 "사람이 맞다고 했다"가 아닙니다. 둘은 다른 축이고, 같이 쓰면 더 정확합니다.

### 3-2. 프로젝트 경계를 넘는 그룹 만들기

`scope_type`은 `project`와 `global` 둘뿐이라, "이 3개 프로젝트에 걸친 결제 관련 결정"처럼 중간 크기의 묶음을 표현할 수 없습니다. 태그는 스코프와 **직교**하므로 프로젝트를 가로지릅니다.

```bash
# 서로 다른 프로젝트의 fact에 같은 태그
memory-bank tag <fact-id-A> billing
memory-bank tag <fact-id-B> billing

memory-bank tags --find billing    # 프로젝트 무관하게 한 묶음으로
```

> 참고: 프로젝트를 넘는 묶음이 **이미 자동으로도** 만들어집니다. 온톨로지 도메인이
> 그 역할을 합니다 — `memory-bank analyze`로 현재 도메인 분포를 볼 수 있습니다.
> 자동 묶음으로 충분하면 태그를 안 써도 됩니다. 태그는 **내가 기준을 정하고 싶을 때**입니다.

### 3-3. 도메인별 커스텀 그룹핑

온톨로지는 LLM이 붙이므로 내 분류 체계와 다를 수 있습니다. 내 체계를 쓰려면 태그로 덮어씁니다. `/`를 쓰면 계층처럼 읽힙니다.

```bash
memory-bank tag <fact-id> domain/payments
memory-bank tag <fact-id> domain/auth
memory-bank tags --find domain/payments
```

### 3-4. 케이스 수집 (버그 리포트, 회고 소재)

"나중에 다시 볼 것"을 모아두는 용도입니다. 대화 중에 발견하는 즉시 붙여두면 나중에 한 번에 꺼낼 수 있습니다.

```bash
memory-bank tag <fact-id> bug-report
memory-bank tag <fact-id> retro-2026q3
memory-bank tags --find retro-2026q3
```

### 3-5. 격리 스코프 (isolation scope)

"이 모바일 앱 프로젝트 관련 fact만 격리해서 보고 싶다"면 두 방법을 조합합니다.

```bash
# 프로젝트 스코프 + 태그 교집합
memory-bank tags --find mobile --project /path/to/project
```

`--find`에 태그를 여러 개 주면 **전부 만족**하는 fact만 나옵니다(AND). `--any`를 붙이면 하나라도 만족하는 것(OR)이 됩니다.

```bash
memory-bank tags --find mobile verified          # 둘 다
memory-bank tags --find mobile billing --any     # 둘 중 하나
```

---

## 4. 규칙 (알아두면 헷갈리지 않는 것들)

**정규화** — 태그는 저장 전에 다듬어집니다.

| 입력 | 저장 |
|---|---|
| `Verified` | `verified` (소문자) |
| `  needs check  ` | `needs-check` (trim + 공백→하이픈) |
| `결제` | `결제` (한글 그대로) |

따라서 `Mobile`과 `mobile`은 같은 태그입니다.

**허용 문자** — 문자(한글 포함), 숫자, 그리고 `-` `_` `.` `/` `:` `"`와 `\`는 저장 형식을 깨뜨릴 수 있어 거부됩니다.

**상한** — 태그 1개당 64자, fact 1개당 32개.

**부분 일치 안 함** — `api`로 검색해도 `api-v2`는 안 잡힙니다. 태그는 정확히 일치해야 합니다.

**전부 아니면 전무** — 태그 여러 개를 한 번에 추가할 때 하나라도 잘못됐으면 **전체가 거부**됩니다. 일부만 들어가서 어느 게 반영됐는지 모르는 상황을 막기 위함입니다.

```bash
$ memory-bank tag <fact-id> ok-tag 'bad"tag'
Error: invalid tag: "bad\"tag"      # ok-tag 도 저장되지 않음
```

---

## 5. 명령어 전체

```bash
# 쓰기
memory-bank tag <fact-id> a b        # 추가 (합집합)
memory-bank tag <fact-id> --remove a # 제거
memory-bank tag <fact-id> --set a b  # 전체 교체
memory-bank tag <fact-id> --clear    # 전부 삭제
memory-bank tag <fact-id>            # 현재 태그 보기

# 읽기
memory-bank tags                          # 태그 인덱스
memory-bank tags --project <path>         # 프로젝트로 한정
memory-bank tags --find a b               # a AND b
memory-bank tags --find a b --any         # a OR b
memory-bank tags --find a --limit 100
```

---

## 6. 그 이상이 필요하면 — DB를 직접 여세요

memory-bank의 저장소는 **로컬 SQLite 파일 하나**입니다. 위 명령으로 안 되는 집계나 일괄 작업은 SQL로 직접 하면 됩니다. 내 컴퓨터의 내 데이터이므로 막을 이유가 없습니다.

```bash
sqlite3 ~/.config/superpowers/conversation-index/db.sqlite
```

```sql
-- 태그별 fact 수
SELECT json_each.value AS tag, COUNT(*) AS n
FROM facts, json_each(facts.tags)
WHERE facts.tags IS NOT NULL AND facts.is_active = 1
GROUP BY tag ORDER BY n DESC;

-- 특정 온톨로지 도메인의 fact에 일괄 태그 부여
UPDATE facts
SET tags = json_insert(COALESCE(tags, '[]'), '$[#]', 'audit-2026q3')
WHERE ontology_category_id IN (
  SELECT c.id FROM ontology_categories c
  JOIN ontology_domains d ON d.id = c.domain_id
  WHERE d.name = 'Security'
) AND (tags IS NULL OR tags NOT LIKE '%"audit-2026q3"%');

-- 손상된 tags 값 찾기 (수작업 편집 후 점검)
SELECT id, tags FROM facts
WHERE tags IS NOT NULL AND json_valid(tags) = 0;
```

> ⚠️ 직접 UPDATE 할 때는 정규화 규칙(소문자, 허용 문자)을 스스로 지켜야 합니다.
> CLI/MCP를 거치면 자동으로 지켜집니다. 손상된 JSON을 넣어도 검색이 죽지는 않고
> 해당 fact의 태그만 빈 값으로 읽힙니다 — 위 `json_valid` 쿼리로 점검하세요.

---

## 7. 요약

- 자동 분류(스코프·카테고리·온톨로지)는 **잘 돌지만 내가 못 만집니다.**
- 태그는 **내가 만지는 유일한 축**이고, 자동 파이프라인이 건드리지 않습니다.
- 신뢰도 레이어, 프로젝트를 넘는 그룹, 커스텀 도메인, 케이스 수집 — 전부 태그 하나로 됩니다.
- 그 이상은 SQLite를 직접 여세요. 내 데이터입니다.

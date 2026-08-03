import Database from 'better-sqlite3';
import { l2DistanceToSimilarity } from './db.js';
import type { AvatarResponse, Fact, RelationType } from './types.js';
import { callHaiku, parseJsonResponse } from './llm.js';
import { classifyLlmError } from './llm-error-class.js';
import { generateEmbedding, initEmbeddings } from './embeddings.js';
import { searchSimilarFacts } from './fact-db.js';
import { getRelatedFacts, listDomains, listCategories } from './ontology-db.js';

const AVATAR_SYSTEM_PROMPT = `You are acting as the user's technical alter ego.
You represent their past engineering decisions, preferences, and patterns.

## Your role
- Answer the question ONLY based on the provided past decisions
- Always cite the specific decision (date and content) that informs your answer
- If you are not confident, say "확인이 필요합니다" (needs verification)
- Be concise and direct

## Output format (JSON only, no markdown wrapper)
{
  "answer": "your response in Korean",
  "confidence": 0.0-1.0,
  "cited_fact_ids": ["fact-id-1", "fact-id-2"]
}

## Confidence guidelines
- 0.9+: direct, explicit past decision found
- 0.7-0.9: inferred from related decisions
- 0.5-0.7: weak inference, needs verification
- below 0.5: not enough information`;

interface AvatarRawResponse {
  answer: string;
  confidence: number;
  cited_fact_ids: string[];
}

export async function askAvatar(
  db: Database.Database,
  question: string,
  project?: string,
): Promise<AvatarResponse> {
  await initEmbeddings();

  const questionEmbedding = await generateEmbedding(question, 'query');
  const scopeProject = project ?? null;

  // Step 1: Vector search for top-10 relevant facts
  const vectorResults = searchSimilarFacts(db, questionEmbedding, scopeProject, 10, 0.6);

  if (vectorResults.length === 0) {
    return {
      answer: '관련된 과거 결정을 찾을 수 없습니다. 아직 충분한 기억이 쌓이지 않았습니다.',
      sources: [],
      confidence: 0,
      relatedDecisions: [],
    };
  }

  // Step 2: Gather ontology context for top facts
  const domains = listDomains(db);
  const categories = listCategories(db);

  const domainMap = new Map(domains.map((d) => [d.id, d.name]));
  const categoryMap = new Map(
    categories.map((c) => [c.id, { name: c.name, domainId: c.domain_id }]),
  );

  // Step 3: Expand with 1-hop ontology relations
  const relatedDecisions: Array<{ fact: Fact; relation: RelationType }> = [];
  const expandedFactIds = new Set(vectorResults.map((r) => r.fact.id));

  for (const { fact } of vectorResults.slice(0, 5)) {
    const related = getRelatedFacts(db, fact.id, 1);
    for (const { fact: relFact, relation } of related) {
      if (!expandedFactIds.has(relFact.id)) {
        expandedFactIds.add(relFact.id);
        relatedDecisions.push({ fact: relFact, relation: relation.relation_type });
      }
    }
  }

  // Step 4: Build context for Haiku
  const factContextLines: string[] = [];

  for (const { fact, distance } of vectorResults) {
    const similarity = l2DistanceToSimilarity(distance).toFixed(2);
    const catInfo = fact.ontology_category_id
      ? categoryMap.get(fact.ontology_category_id)
      : undefined;
    const domainName = catInfo ? (domainMap.get(catInfo.domainId) ?? 'Unknown') : 'Unknown';
    const catName = catInfo ? catInfo.name : 'Unknown';

    factContextLines.push(
      `[ID:${fact.id}] [${domainName}/${catName}] [${fact.category}] (relevance:${similarity}) "${fact.fact}" (date: ${fact.created_at.slice(0, 10)})`,
    );
  }

  for (const { fact, relation } of relatedDecisions) {
    const catInfo = fact.ontology_category_id
      ? categoryMap.get(fact.ontology_category_id)
      : undefined;
    const domainName = catInfo ? (domainMap.get(catInfo.domainId) ?? 'Unknown') : 'Unknown';
    const catName = catInfo ? catInfo.name : 'Unknown';

    factContextLines.push(
      `[ID:${fact.id}] [${domainName}/${catName}] [${fact.category}] [relation:${relation}] "${fact.fact}" (date: ${fact.created_at.slice(0, 10)})`,
    );
  }

  const prompt = [
    `Question: ${question}`,
    '',
    'Past decisions and knowledge:',
    ...factContextLines,
  ].join('\n');

  // Step 5: Call Haiku.
  // callHaiku 는 이제 재시도를 소진하면 throw 한다(빈 응답 포함). 여기는 사용자 대면
  // 경로라 크래시 대신 degrade 하되, **실패를 실패로** 표면화한다 — 예전에는 빈 응답이
  // '응답을 생성할 수 없습니다'라는 정상 답변 형식으로 반환돼 호출 실패와 "답할 근거가
  // 없음"이 구분되지 않았다(fail-loud-no-unapproved-fallback).
  let response: string;
  try {
    response = await callHaiku(AVATAR_SYSTEM_PROMPT, prompt, 1024);
  } catch (error) {
    // 원문 provider 에러는 엔드포인트·토큰 조각 등을 담을 수 있어 사용자 대면 응답에
    // 그대로 싣지 않는다 — 분류만 노출하고 상세는 서버 로그로 (Codex 리뷰 MEDIUM).
    console.error('ask_avatar: LLM call failed after retries:', error);
    return {
      answer: `⚠️ LLM 호출이 재시도 후에도 실패해 답변을 생성하지 못했습니다 (${classifyLlmError(error)}). 잠시 후 다시 시도해 주세요.`,
      sources: [],
      confidence: 0,
      relatedDecisions,
    };
  }
  const parsed = parseJsonResponse<AvatarRawResponse>(response);

  if (!parsed) {
    // 호출은 성공(비어있지 않은 본문)했는데 JSON 이 아님 — 본문을 그대로 보여준다.
    return {
      answer: response,
      sources: [],
      confidence: 0,
      relatedDecisions,
    };
  }

  // Step 6: Build structured sources
  const citedIds = new Set(parsed.cited_fact_ids ?? []);
  const sources: AvatarResponse['sources'] = vectorResults
    .filter((r) => citedIds.size === 0 || citedIds.has(r.fact.id))
    .map(({ fact, distance }) => {
      const catInfo = fact.ontology_category_id
        ? categoryMap.get(fact.ontology_category_id)
        : undefined;
      const domainName = catInfo ? (domainMap.get(catInfo.domainId) ?? 'Unknown') : 'Unknown';
      const catName = catInfo ? catInfo.name : 'Unknown';
      const relevance = parseFloat(l2DistanceToSimilarity(distance).toFixed(3));

      return {
        fact,
        domain: domainName,
        category: catName,
        relevance,
      };
    });

  return {
    answer: parsed.answer,
    sources,
    confidence: Math.min(1, Math.max(0, parsed.confidence ?? 0)),
    relatedDecisions,
  };
}

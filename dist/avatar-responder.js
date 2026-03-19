import { callHaiku, parseJsonResponse } from './llm.js';
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
export async function askAvatar(db, question, project) {
    await initEmbeddings();
    const questionEmbedding = await generateEmbedding(question);
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
    const categoryMap = new Map(categories.map((c) => [c.id, { name: c.name, domainId: c.domain_id }]));
    // Step 3: Expand with 1-hop ontology relations
    const relatedDecisions = [];
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
    const factContextLines = [];
    for (const { fact, distance } of vectorResults) {
        const similarity = (1 - (distance * distance) / 2).toFixed(2);
        const catInfo = fact.ontology_category_id
            ? categoryMap.get(fact.ontology_category_id)
            : undefined;
        const domainName = catInfo ? (domainMap.get(catInfo.domainId) ?? 'Unknown') : 'Unknown';
        const catName = catInfo ? catInfo.name : 'Unknown';
        factContextLines.push(`[ID:${fact.id}] [${domainName}/${catName}] [${fact.category}] (relevance:${similarity}) "${fact.fact}" (date: ${fact.created_at.slice(0, 10)})`);
    }
    for (const { fact, relation } of relatedDecisions) {
        const catInfo = fact.ontology_category_id
            ? categoryMap.get(fact.ontology_category_id)
            : undefined;
        const domainName = catInfo ? (domainMap.get(catInfo.domainId) ?? 'Unknown') : 'Unknown';
        const catName = catInfo ? catInfo.name : 'Unknown';
        factContextLines.push(`[ID:${fact.id}] [${domainName}/${catName}] [${fact.category}] [relation:${relation}] "${fact.fact}" (date: ${fact.created_at.slice(0, 10)})`);
    }
    const prompt = [
        `Question: ${question}`,
        '',
        'Past decisions and knowledge:',
        ...factContextLines,
    ].join('\n');
    // Step 5: Call Haiku
    const response = await callHaiku(AVATAR_SYSTEM_PROMPT, prompt, 1024);
    const parsed = parseJsonResponse(response);
    if (!parsed) {
        return {
            answer: response || '응답을 생성할 수 없습니다.',
            sources: [],
            confidence: 0,
            relatedDecisions,
        };
    }
    // Step 6: Build structured sources
    const citedIds = new Set(parsed.cited_fact_ids ?? []);
    const sources = vectorResults
        .filter((r) => citedIds.size === 0 || citedIds.has(r.fact.id))
        .map(({ fact, distance }) => {
        const catInfo = fact.ontology_category_id
            ? categoryMap.get(fact.ontology_category_id)
            : undefined;
        const domainName = catInfo ? (domainMap.get(catInfo.domainId) ?? 'Unknown') : 'Unknown';
        const catName = catInfo ? catInfo.name : 'Unknown';
        const relevance = parseFloat((1 - (distance * distance) / 2).toFixed(3));
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

import Database from 'better-sqlite3';
import type { Fact, RelationType } from './types.js';
import { callHaiku, parseJsonResponse } from './llm.js';
import { generateEmbedding } from './embeddings.js';
import { searchSimilarFacts } from './fact-db.js';
import {
  listDomains,
  listCategories,
  getDomainByName,
  getCategoryByName,
  createDomain,
  createCategory,
  classifyFact,
  createRelation,
} from './ontology-db.js';

interface ClassifyResponse {
  domain: string;
  category: string;
  is_new_domain: boolean;
  is_new_category: boolean;
  domain_description?: string;
  category_description?: string;
}

interface DetectRelationResponse {
  has_relation: boolean;
  relation_type: RelationType | null;
  reasoning: string;
}

const CLASSIFY_SYSTEM_PROMPT = `You are an ontology classifier for technical decision facts.
Given a fact and a list of existing domains/categories, classify the fact.

## Domains represent broad areas (e.g., "Architecture", "Frontend", "Backend", "DevOps", "Testing", "Database")
## Categories are specific topics within a domain (e.g., "State Management", "API Design", "Authentication")

## Rules
- Reuse existing domains/categories when appropriate (prefer reuse over creation)
- Create new domain/category only when no existing one fits
- domain and category names must be in English, concise (1-3 words)

## Output format (JSON only, no markdown)
{
  "domain": "existing or new domain name",
  "category": "existing or new category name",
  "is_new_domain": false,
  "is_new_category": false,
  "domain_description": "only if is_new_domain is true",
  "category_description": "only if is_new_category is true"
}`;

const DETECT_RELATION_SYSTEM_PROMPT = `You are analyzing relationships between technical decision facts.
Given a new fact and an existing fact, determine if there is a meaningful relationship.

## Relation types
- INFLUENCES: new fact affects or shapes the existing fact's domain
- SUPERSEDES: new fact replaces or overrides the existing fact
- SUPPORTS: new fact provides evidence or reinforcement for the existing fact
- CONTRADICTS: new fact conflicts with the existing fact

## Rules
- Only report a relation if it is clear and meaningful
- If no meaningful relation exists, set has_relation to false

## Output format (JSON only, no markdown)
{
  "has_relation": true,
  "relation_type": "INFLUENCES|SUPERSEDES|SUPPORTS|CONTRADICTS",
  "reasoning": "one-line explanation"
}`;

export async function classifyFactToOntology(
  db: Database.Database,
  fact: Fact,
): Promise<{ domainId: string; categoryId: string }> {
  const domains = listDomains(db);
  const categories = listCategories(db);

  const domainList = domains.map((d) => `- ${d.name}: ${d.description ?? '(no description)'}`).join('\n');
  const categoryList = categories
    .map((c) => {
      const domain = domains.find((d) => d.id === c.domain_id);
      return `- ${domain?.name ?? '?'} / ${c.name}: ${c.description ?? '(no description)'}`;
    })
    .join('\n');

  const prompt = [
    `Fact: "${fact.fact}"`,
    `Fact category: ${fact.category}`,
    '',
    'Existing domains:',
    domainList || '(none)',
    '',
    'Existing categories (domain / category):',
    categoryList || '(none)',
  ].join('\n');

  const response = await callHaiku(CLASSIFY_SYSTEM_PROMPT, prompt, 512);
  const parsed = parseJsonResponse<ClassifyResponse>(response);

  if (!parsed) {
    // Fallback: use a generic domain/category
    return ensureFallbackCategory(db);
  }

  // Resolve or create domain
  let domain = getDomainByName(db, parsed.domain);
  if (!domain) {
    domain = createDomain(db, parsed.domain, parsed.domain_description);
  }

  // Resolve or create category
  let category = getCategoryByName(db, parsed.category, domain.id);
  if (!category) {
    category = createCategory(db, domain.id, parsed.category, parsed.category_description);
  }

  // Apply classification
  classifyFact(db, fact.id, category.id);

  return { domainId: domain.id, categoryId: category.id };
}

export async function detectRelations(
  db: Database.Database,
  newFact: Fact,
  topK: number = 5,
): Promise<void> {
  if (!newFact.embedding) return;

  const embeddingArray = Array.from(newFact.embedding);
  const similar = searchSimilarFacts(db, embeddingArray, newFact.scope_project, topK, 0.75);
  const candidates = similar.filter((s) => s.fact.id !== newFact.id);

  for (const { fact: existingFact } of candidates) {
    const prompt = [
      `New fact: "${newFact.fact}"`,
      `Existing fact: "${existingFact.fact}"`,
      `New fact category: ${newFact.category}`,
      `Existing fact category: ${existingFact.category}`,
    ].join('\n');

    try {
      const response = await callHaiku(DETECT_RELATION_SYSTEM_PROMPT, prompt, 256);
      const result = parseJsonResponse<DetectRelationResponse>(response);

      if (result && result.has_relation && result.relation_type) {
        createRelation(db, newFact.id, result.relation_type, existingFact.id, result.reasoning);
      }
    } catch (error) {
      // Non-fatal: relation detection failure should not block fact saving
      console.error(`Relation detection failed for facts ${newFact.id} / ${existingFact.id}:`, error);
    }
  }
}

export async function classifyAndLinkFact(
  db: Database.Database,
  factId: string,
  embedding?: number[],
): Promise<void> {
  const row = db.prepare(`SELECT * FROM facts WHERE id = ? AND is_active = 1`).get(factId);
  if (!row) return;

  const fact = rowToFact(row as Record<string, unknown>);

  // Re-attach embedding if provided (in case the row doesn't have it yet)
  if (embedding && !fact.embedding) {
    fact.embedding = new Float32Array(embedding);
  }

  try {
    await classifyFactToOntology(db, fact);
  } catch (error) {
    console.error(`Ontology classification failed for fact ${factId}:`, error);
  }

  try {
    await detectRelations(db, fact);
  } catch (error) {
    console.error(`Relation detection failed for fact ${factId}:`, error);
  }
}

function ensureFallbackCategory(db: Database.Database): { domainId: string; categoryId: string } {
  let domain = getDomainByName(db, 'General');
  if (!domain) {
    domain = createDomain(db, 'General', 'General purpose facts');
  }
  let category = getCategoryByName(db, 'Misc', domain.id);
  if (!category) {
    category = createCategory(db, domain.id, 'Misc', 'Miscellaneous facts');
  }
  return { domainId: domain.id, categoryId: category.id };
}

function rowToFact(row: Record<string, unknown>): Fact {
  const embeddingRaw = row['embedding'];
  let embedding: Float32Array | null = null;
  if (embeddingRaw instanceof Buffer) {
    embedding = new Float32Array(
      embeddingRaw.buffer,
      embeddingRaw.byteOffset,
      embeddingRaw.byteLength / 4,
    );
  } else if (embeddingRaw instanceof Uint8Array) {
    embedding = new Float32Array(
      embeddingRaw.buffer,
      embeddingRaw.byteOffset,
      embeddingRaw.byteLength / 4,
    );
  }

  return {
    id: row['id'] as string,
    fact: row['fact'] as string,
    category: row['category'] as Fact['category'],
    scope_type: row['scope_type'] as Fact['scope_type'],
    scope_project: (row['scope_project'] as string | null) ?? null,
    source_exchange_ids: row['source_exchange_ids']
      ? JSON.parse(row['source_exchange_ids'] as string)
      : [],
    embedding,
    created_at: row['created_at'] as string,
    updated_at: row['updated_at'] as string,
    consolidated_count: row['consolidated_count'] as number,
    is_active: Boolean(row['is_active']),
  };
}

export { generateEmbedding };

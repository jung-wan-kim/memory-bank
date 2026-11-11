import { l2DistanceToSimilarity } from './db.js';
import { searchFactsFiltered, getRevisions, FACT_KNN_MAX } from './fact-db.js';
import { listDomains, listCategories, getRelatedFacts } from './ontology-db.js';
import { clipLine, summarizeRelated } from './related-format.js';
/**
 * Text of the fact tools (search_facts, trace_fact, cross_project_insights, explore_graph), given the query
 * embedding. Kept out of mcp-server.ts — that module starts the server when imported — so the tools' output
 * can be tested: what they filter, what they cap, and what they say they left out.
 */
/** Source conversations listed per traced fact (a fact can record thousands of source ids). */
export const TRACE_MAX_SOURCES = 5;
/** Connected facts listed per seed in explore_graph, and the characters of each. */
export const EXPLORE_MAX_CONNECTED = 20;
export const EXPLORE_FACT_CHARS = 300;
// getRelatedFacts defaults, spelled out because the scope argument comes after them.
const RELATED_DECAY = 0.6;
const RELATED_MIN_RELEVANCE = 0.2;
const similarityOf = (distance) => l2DistanceToSimilarity(distance).toFixed(3);
export function formatFactSearch(db, queryEmbedding, params) {
    // Normalize tags the same way the writer does, so "Mobile" matches "mobile".
    const wantedTags = (params.tags ?? [])
        .map((t) => t.trim().replace(/\s+/g, '-').toLowerCase())
        .filter(Boolean);
    // Category, agent and tag conditions go INTO the search: applied after its cut they turned facts that
    // exist into "no matching facts".
    const filter = (fact) => {
        if (params.category && fact.category !== params.category)
            return false;
        if (params.coding_agent && (fact.coding_agent || 'claude-code') !== params.coding_agent)
            return false;
        if (wantedTags.length) {
            const have = new Set(fact.tags ?? []);
            if (!wantedTags.every((t) => have.has(t)))
                return false;
        }
        return true;
    };
    const { results, truncated, examined } = searchFactsFiltered(db, queryEmbedding, {
        project: params.project,
        limit: params.limit,
        filter,
        foldSameText: true,
    });
    const agentLabel = params.coding_agent ? ` | Agent: ${params.coding_agent}` : '';
    let output = `# Facts Search Results\n\nQuery: "${params.query}"\nProject: ${params.project}${agentLabel}\nResults: ${results.length}\n\n`;
    if (results.length === 0) {
        output += '_No matching facts found._\n';
    }
    // Build ontology lookup
    const domainMap = new Map(listDomains(db).map((d) => [d.id, d.name]));
    const catMap = new Map(listCategories(db).map((c) => [c.id, { name: c.name, domainId: c.domain_id }]));
    for (const { fact, distance, duplicateIds } of results) {
        const catInfo = fact.ontology_category_id ? catMap.get(fact.ontology_category_id) : undefined;
        const domainName = catInfo ? (domainMap.get(catInfo.domainId) ?? '') : '';
        const catName = catInfo ? catInfo.name : '';
        output += `## [${fact.category}] ${fact.fact}\n`;
        output += `- ID: ${fact.id}\n`;
        // The same sentence stored under other ids: shown once, the copies named so they can be handled together.
        if (duplicateIds.length)
            output += `- Same sentence also stored as: ${duplicateIds.join(', ')}\n`;
        if (fact.tags && fact.tags.length)
            output += `- Tags: ${fact.tags.join(', ')}\n`;
        const factAgent = fact.coding_agent || 'claude-code';
        output += `- Scope: ${fact.scope_type}${fact.scope_project ? ` (${fact.scope_project})` : ''} | Agent: ${factAgent}\n`;
        output += `- Confirmed: ${fact.consolidated_count}x | Similarity: ${similarityOf(distance)}\n`;
        if (domainName)
            output += `- Ontology: ${domainName}/${catName}\n`;
        output += `- Created: ${fact.created_at}\n`;
        if (params.include_revisions) {
            const revisions = getRevisions(db, fact.id);
            if (revisions.length > 0) {
                output += '- Revisions:\n';
                for (const rev of revisions) {
                    output += `  - ${rev.created_at}: "${rev.previous_fact}" → "${rev.new_fact}" (${rev.reason})\n`;
                }
            }
        }
        // Graph relations of this fact — within the searched project's scope, a few, short.
        const related = summarizeRelated(getRelatedFacts(db, fact.id, 1, RELATED_DECAY, RELATED_MIN_RELEVANCE, params.project));
        if (related.shown.length > 0) {
            output += `- Related:\n`;
            for (const rel of related.shown)
                output += `  - [${rel.relationType}] ${rel.text}\n`;
            if (related.omitted > 0)
                output += `  - _…and ${related.omitted} more related facts (explore_graph lists them)._\n`;
        }
        output += '\n';
    }
    if (truncated) {
        output += `_Note: only the nearest ${examined} facts could be examined (vector ceiling ${FACT_KNN_MAX}) and ${results.length} passed the project/category/agent/tag conditions — more may exist; narrow the query._\n`;
    }
    return output;
}
export function formatFactTrace(db, queryEmbedding, params) {
    // Scope decided inside the search (see formatFactSearch): a project's fact behind other projects' nearer
    // facts was "no matching facts".
    const { results } = searchFactsFiltered(db, queryEmbedding, { project: params.project, limit: params.limit, threshold: 0.5 });
    if (results.length === 0) {
        return 'No matching facts found to trace.';
    }
    let output = `# Fact Provenance Trace\n\nQuery: "${params.query}"\n\n`;
    // One statement per fact for its sources, however many ids it records (a fact can carry thousands):
    // how many of them are still indexed, and the newest few with a 200-char look at the question.
    const sourceCount = db.prepare(`SELECT COUNT(*) AS n FROM exchanges WHERE id IN (SELECT value FROM json_each(?))`);
    const sourceRows = db.prepare(`
    SELECT project, timestamp, substr(user_message, 1, 200) AS user_head, archive_path, line_start, line_end
    FROM exchanges
    WHERE id IN (SELECT value FROM json_each(?))
    ORDER BY timestamp DESC, id
    LIMIT ?
  `);
    for (const { fact, distance } of results) {
        output += `## ${fact.fact}\n`;
        output += `- Category: ${fact.category} | Scope: ${fact.scope_type}\n`;
        output += `- Similarity: ${similarityOf(distance)} | Confirmed: ${fact.consolidated_count}x\n`;
        output += `- Created: ${fact.created_at}\n`;
        // Trace back to source exchanges
        const sourceIds = [...new Set(fact.source_exchange_ids ?? [])];
        if (sourceIds.length > 0) {
            const idsJson = JSON.stringify(sourceIds);
            const indexed = sourceCount.get(idsJson).n;
            const shown = sourceRows.all(idsJson, TRACE_MAX_SOURCES);
            output += `\n### Source Conversations\n\n`;
            for (const exchange of shown) {
                output += `- **[${exchange.project}, ${exchange.timestamp.slice(0, 10)}]**\n`;
                output += `  "${exchange.user_head.replace(/\s+/g, ' ')}..."\n`;
                output += `  Lines ${exchange.line_start}-${exchange.line_end} in ${exchange.archive_path}\n\n`;
            }
            if (indexed > shown.length) {
                output += `_…and ${indexed - shown.length} more source exchanges (the newest ${shown.length} are shown)._\n\n`;
            }
            if (indexed < sourceIds.length) {
                output += `_${sourceIds.length - indexed} recorded source ids are no longer in the index._\n\n`;
            }
        }
        else {
            output += `\n_Source exchanges not available._\n\n`;
        }
        // Show ontology context
        const revisions = getRevisions(db, fact.id);
        if (revisions.length > 0) {
            output += `### Revision History\n\n`;
            for (const rev of revisions) {
                output += `- ${rev.created_at.slice(0, 10)}: "${rev.previous_fact}" → "${rev.new_fact}" (${rev.reason})\n`;
            }
            output += '\n';
        }
        // Show graph relations — within the traced project's scope, a few, short.
        const related = summarizeRelated(getRelatedFacts(db, fact.id, 1, RELATED_DECAY, RELATED_MIN_RELEVANCE, params.project));
        if (related.shown.length > 0) {
            output += `### Related Facts (1-hop)\n\n`;
            for (const rel of related.shown)
                output += `- **[${rel.relationType}]** ${rel.text}\n`;
            if (related.omitted > 0)
                output += `- _…and ${related.omitted} more related facts (explore_graph lists them)._\n`;
            output += '\n';
        }
    }
    return output;
}
export function formatCrossProjectInsights(db, queryEmbedding, params) {
    // Facts of OTHER projects only, decided inside the search: taking limit×3 neighbours and dropping the
    // global and own-project ones afterwards left one result when 14 of the 15 nearest were global.
    const { results } = searchFactsFiltered(db, queryEmbedding, {
        project: params.currentProject,
        scope: 'other-projects',
        limit: params.limit,
        threshold: 0.5,
    });
    if (results.length === 0) {
        return `No cross-project insights found for "${params.query}". Similar decisions may not exist in other projects yet.`;
    }
    // Group by project
    const byProject = new Map();
    for (const { fact, distance } of results) {
        const proj = fact.scope_project || 'global';
        if (!byProject.has(proj))
            byProject.set(proj, []);
        byProject.get(proj).push({ fact, distance });
    }
    let output = `# Cross-Project Insights\n\nQuery: "${params.query}"\nExcluding: ${params.currentProject}\n\n`;
    for (const [project, facts] of byProject) {
        output += `## Project: ${project}\n\n`;
        for (const { fact, distance } of facts) {
            const similarity = Math.round(l2DistanceToSimilarity(distance) * 100);
            output += `- **[${fact.category}]** ${fact.fact} _(${similarity}% relevant, ${fact.created_at.slice(0, 10)})_\n`;
        }
        output += '\n';
    }
    return output;
}
export function formatGraphExploration(db, queryEmbedding, params) {
    const { results: seedFacts } = searchFactsFiltered(db, queryEmbedding, { project: params.project ?? null, limit: 3, threshold: 0.5 });
    if (seedFacts.length === 0) {
        return `No facts found related to "${params.query}" to start graph exploration.`;
    }
    // Build domain/category maps
    const domainMap = new Map(listDomains(db).map((d) => [d.id, d.name]));
    const categoryMap = new Map(listCategories(db).map((c) => [c.id, { name: c.name, domainId: c.domain_id }]));
    let output = `# Knowledge Graph Exploration\n\nSeed: "${params.query}" | Depth: ${params.hops} hops\n\n`;
    const allDiscovered = new Set();
    for (const { fact: seedFact, distance } of seedFacts) {
        const similarity = Math.round(l2DistanceToSimilarity(distance) * 100);
        const catInfo = seedFact.ontology_category_id ? categoryMap.get(seedFact.ontology_category_id) : undefined;
        const domainName = catInfo ? (domainMap.get(catInfo.domainId) ?? '?') : '?';
        const catName = catInfo ? catInfo.name : '?';
        output += `## Seed: ${seedFact.fact}\n`;
        output += `- [${domainName}/${catName}] ${seedFact.category} | ${similarity}% relevant\n\n`;
        allDiscovered.add(seedFact.id);
        // Multi-hop traversal (cross-project by design)
        const related = getRelatedFacts(db, seedFact.id, params.hops);
        if (related.length === 0) {
            output += `_No connected facts found._\n\n`;
            continue;
        }
        // Group by hop distance (approximate via order)
        output += `### Connected Facts (${related.length} found, up to ${params.hops} hops)\n\n`;
        // Most relevant first (getRelatedFacts order); a hub can have hundreds, each of any length.
        let listed = 0;
        let unlisted = 0;
        for (const { fact: relFact, relation } of related) {
            if (allDiscovered.has(relFact.id))
                continue;
            allDiscovered.add(relFact.id);
            if (listed >= EXPLORE_MAX_CONNECTED) {
                unlisted++;
                continue;
            }
            listed++;
            const relCatInfo = relFact.ontology_category_id ? categoryMap.get(relFact.ontology_category_id) : undefined;
            const relDomain = relCatInfo ? (domainMap.get(relCatInfo.domainId) ?? '?') : '?';
            const relCat = relCatInfo ? relCatInfo.name : '?';
            output += `- **[${relation.relation_type}]** ${clipLine(relFact.fact, EXPLORE_FACT_CHARS)}\n`;
            output += `  [${relDomain}/${relCat}] ${relFact.category} | ${relFact.created_at.slice(0, 10)}\n`;
            if (relation.reasoning) {
                output += `  _${clipLine(relation.reasoning, EXPLORE_FACT_CHARS)}_\n`;
            }
        }
        if (unlisted > 0) {
            output += `- _…and ${unlisted} more connected facts (search_facts finds them by meaning)._\n`;
        }
        output += '\n';
    }
    output += `\n_Total unique facts discovered: ${allDiscovered.size}_\n`;
    return output;
}

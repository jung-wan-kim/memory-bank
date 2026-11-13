import { getOntologyTree, getRelatedFacts } from './ontology-db.js';
import { clipLine, summarizeRelated } from './related-format.js';
/**
 * Output of the `search_ontology` tool.
 *
 * The tool used to print every fact of every category — 8.7 million characters without a filter on the
 * live DB, up to 1.6 million with a domain filter. It now answers in levels: no filter → domains and their
 * largest categories with fact counts; a `category` filter (or facts_per_category) → the top facts of the
 * matching categories. Every level is bounded (categories per domain, facts per category, characters per
 * fact, characters in total) and says what it left out and which filter reaches it.
 */
/** Most characters one answer carries, closing note included. */
export const ONTOLOGY_MAX_OUTPUT_CHARS = 20_000;
/**
 * Characters of the ceiling kept for what is written after the last block: one domain's closing lines
 * ("…and N more categories", "N empty categories not listed") and the final note — none of them carries a name.
 */
const CLOSING_RESERVE_CHARS = 600;
const BODY_MAX_CHARS = ONTOLOGY_MAX_OUTPUT_CHARS - CLOSING_RESERVE_CHARS;
/** Characters of one fact line — the full text is one search_facts away. */
export const ONTOLOGY_FACT_CHARS = 300;
/** Facts shown per category when a `category` filter is given and facts_per_category is not. */
export const ONTOLOGY_DEFAULT_FACTS_PER_CATEGORY = 5;
/** Categories listed per domain: in the overview / when a `domain` filter drills into one / with facts. */
export const ONTOLOGY_DEFAULT_CATEGORIES_OVERVIEW = 8;
export const ONTOLOGY_DEFAULT_CATEGORIES_DOMAIN = 200;
export const ONTOLOGY_DEFAULT_CATEGORIES_WITH_FACTS = 20;
/** Largest max_categories the tool accepts. A domain with more is paged with category_offset. */
export const ONTOLOGY_MAX_CATEGORIES = 200;
/**
 * Lower bounds of what a category block prints (heading + count line; two lines per fact). They decide how
 * many categories can possibly fit under the output ceiling, so only those categories' facts are loaded.
 */
const CATEGORY_BLOCK_MIN_CHARS = 16;
const FACT_LINES_MIN_CHARS = 40;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const sum = (entries) => entries.reduce((total, entry) => total + entry.factCount, 0);
/** `locale`: the order of equally large names is the reading session's, not this process's (undefined = the process default). */
export function formatOntologyBrowse(db, params, locale) {
    const factsPerCategory = params.facts_per_category ?? (params.category ? ONTOLOGY_DEFAULT_FACTS_PER_CATEGORY : 0);
    const withFacts = factsPerCategory > 0;
    const maxCategories = params.max_categories
        ?? (withFacts
            ? ONTOLOGY_DEFAULT_CATEGORIES_WITH_FACTS
            : params.domain ? ONTOLOGY_DEFAULT_CATEGORIES_DOMAIN : ONTOLOGY_DEFAULT_CATEGORIES_OVERVIEW);
    const offset = params.category_offset ?? 0;
    // One aggregate JOIN: the tree with active-fact counts, no fact rows.
    const tree = getOntologyTree(db, { domain: params.domain, category: params.category, factsPerCategory: 0 });
    let output = '# Ontology Tree\n\n';
    if (tree.length === 0) {
        const filtered = params.domain || params.category;
        return output + (filtered
            ? '_No domain or category matches the filter._\n'
            : '_No ontology data found. Facts are classified automatically as they are extracted._\n');
    }
    // Largest first at both levels: under a ceiling, the order decides what is seen.
    const domains = tree
        .map(({ domain, categories }) => {
        const nonEmpty = categories
            .filter((entry) => entry.factCount > 0)
            .sort((a, b) => b.factCount - a.factCount || a.category.name.localeCompare(b.category.name, locale));
        return {
            domain,
            listed: nonEmpty.slice(offset, offset + maxCategories),
            rest: nonEmpty.slice(offset + maxCategories),
            categoryCount: nonEmpty.length,
            emptyCount: categories.length - nonEmpty.length,
            factCount: sum(nonEmpty),
        };
    })
        .sort((a, b) => b.factCount - a.factCount || a.domain.name.localeCompare(b.domain.name, locale));
    const totalCategories = domains.reduce((n, d) => n + d.categoryCount, 0);
    const totalFacts = domains.reduce((n, d) => n + d.factCount, 0);
    output += `${plural(domains.length, 'domain', 'domains')} · ${plural(totalCategories, 'category', 'categories')} · ${plural(totalFacts, 'active fact', 'active facts')}`;
    if (params.domain || params.category)
        output += ' match the filter';
    output += '\n\n';
    // Facts for the categories that can be shown — one ranked query, not one per category. Walking the
    // display order with the block lower bounds gives the last category that could still fit under the
    // ceiling; nothing after it is ever printed, so nothing after it is loaded (at most ~500 fact rows).
    const factsByCategory = new Map();
    if (withFacts) {
        const ids = [];
        let lowerBound = 0;
        for (const entry of domains.flatMap((d) => d.listed)) {
            if (lowerBound > ONTOLOGY_MAX_OUTPUT_CHARS)
                break;
            ids.push(entry.category.id);
            lowerBound += CATEGORY_BLOCK_MIN_CHARS + FACT_LINES_MIN_CHARS * Math.min(entry.factCount, factsPerCategory);
        }
        if (ids.length > 0) {
            for (const { categories } of getOntologyTree(db, { categoryIds: ids, factsPerCategory })) {
                for (const entry of categories)
                    factsByCategory.set(entry.category.id, entry.facts);
            }
        }
    }
    // Room kept for a block's count line and closing "more facts" line, written once the facts that fit are known.
    const BLOCK_FRAME_CHARS = 200;
    /**
     * One category's block within `room` characters: null when it does not fit at all, `cutShort` when only
     * some of its loaded facts fit. Facts are added one at a time — a category whose facts are more than the
     * whole ceiling (the largest real ones are) still shows as many as fit instead of nothing.
     */
    const categoryBlock = (entry, room) => {
        if (!withFacts) {
            const line = `- ${entry.category.name} (${entry.factCount})\n`;
            return line.length <= room ? { text: line, cutShort: false } : null;
        }
        let heading = `### ${entry.category.name}`;
        if (entry.category.description)
            heading += ` — ${clipLine(entry.category.description, ONTOLOGY_FACT_CHARS)}`;
        const facts = factsByCategory.get(entry.category.id) ?? [];
        let body = '';
        let shown = 0;
        for (const fact of facts) {
            let lines = `- **[${fact.category}]** ${clipLine(fact.fact, ONTOLOGY_FACT_CHARS)}\n`;
            lines += `  - ID: ${fact.id} | Confirmed: ${fact.consolidated_count}x | ${fact.created_at.slice(0, 10)}\n`;
            if (params.include_relations) {
                const related = summarizeRelated(getRelatedFacts(db, fact.id, 1));
                for (const rel of related.shown)
                    lines += `  - ↔ [${rel.relationType}] "${rel.text}"\n`;
                if (related.omitted > 0)
                    lines += `  - _…and ${related.omitted} more related facts (explore_graph lists them)._\n`;
            }
            if (heading.length + BLOCK_FRAME_CHARS + body.length + lines.length > room)
                break;
            body += lines;
            shown++;
        }
        if (shown === 0)
            return null;
        const cutShort = shown < facts.length;
        let block = `${heading}\n(${plural(entry.factCount, 'fact', 'facts')}${shown < entry.factCount ? `, top ${shown} shown` : ''})\n\n${body}`;
        if (shown < entry.factCount) {
            block += cutShort
                ? `- _…and ${entry.factCount - shown} more facts not shown (output limit) — narrow the filter or use search_facts._\n`
                : `- _…and ${entry.factCount - shown} more facts — raise \`facts_per_category\` or use search_facts._\n`;
        }
        return { text: block + '\n', cutShort };
    };
    // What the ceiling cut off, counted so the closing note can name it.
    let cutCategories = 0;
    let cutFacts = 0;
    let cutDomains = 0;
    let full = false;
    for (const d of domains) {
        if (full) {
            cutDomains++;
            cutCategories += d.categoryCount;
            cutFacts += d.factCount;
            continue;
        }
        let header = `## ${d.domain.name} — ${plural(d.factCount, 'fact', 'facts')} in ${plural(d.categoryCount, 'category', 'categories')}\n`;
        if (d.domain.description)
            header += `> ${clipLine(d.domain.description, ONTOLOGY_FACT_CHARS)}\n`;
        if (offset > 0) {
            header += d.listed.length > 0
                ? `_Largest first: categories ${offset + 1}-${offset + d.listed.length} of ${d.categoryCount}._\n`
                : `_category_offset ${offset} is past the last of this domain's ${plural(d.categoryCount, 'category', 'categories')}._\n`;
        }
        header += '\n';
        if (output.length + header.length > BODY_MAX_CHARS) {
            full = true;
            cutDomains++;
            cutCategories += d.categoryCount;
            cutFacts += d.factCount;
            continue;
        }
        output += header;
        let listedHere = 0;
        for (const entry of d.listed) {
            const block = full ? null : categoryBlock(entry, BODY_MAX_CHARS - output.length);
            if (!block) {
                full = true;
                cutCategories++;
                cutFacts += entry.factCount;
                continue;
            }
            output += block.text;
            listedHere++;
            if (block.cutShort)
                full = true; // its own closing line counts the facts left out
        }
        if (full) {
            cutCategories += d.rest.length;
            cutFacts += sum(d.rest);
            if (listedHere < d.categoryCount)
                cutDomains++;
            continue;
        }
        const tail = [];
        if (d.rest.length > 0) {
            // "Raise max_categories" only while it can be raised: it used to be said at the maximum too, where the
            // categories behind it could not be listed at all.
            const raise = maxCategories < ONTOLOGY_MAX_CATEGORIES ? ', raise `max_categories`' : '';
            tail.push(`- _…and ${plural(d.rest.length, 'more category', 'more categories')} (${plural(sum(d.rest), 'fact', 'facts')}) — narrow with \`category\`${raise}, or list the next ones with \`category_offset: ${offset + maxCategories}\`._`);
        }
        if (d.emptyCount > 0) {
            tail.push(`- _${plural(d.emptyCount, 'empty category', 'empty categories')} not listed._`);
        }
        if (tail.length > 0)
            output += tail.join('\n') + '\n';
        if (!withFacts || tail.length > 0)
            output += '\n';
    }
    if (full && cutCategories === 0) {
        output += `---\n_Output limit (${ONTOLOGY_MAX_OUTPUT_CHARS} chars) reached inside the last category shown — narrow the \`category\` filter or lower \`facts_per_category\`._\n`;
    }
    else if (full) {
        output += `---\n_Output limit (${ONTOLOGY_MAX_OUTPUT_CHARS} chars) reached: ${plural(cutCategories, 'category', 'categories')} `
            + `(${plural(cutFacts, 'fact', 'facts')}) in ${plural(cutDomains, 'domain', 'domains')} not shown — narrow the \`domain\` / \`category\` filter._\n`;
    }
    else if (!withFacts) {
        output += '---\n_Names and counts only. Pass `domain` to list more of one domain\'s categories, `category` to read the top facts of the matching categories (`facts_per_category` sets how many)._\n';
    }
    return output;
}

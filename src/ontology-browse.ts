import type Database from 'better-sqlite3';
import { getOntologyTree, getRelatedFacts } from './ontology-db.js';
import { clipLine, summarizeRelated } from './related-format.js';
import type { DomainTree } from './types.js';

/**
 * Output of the `search_ontology` tool.
 *
 * The tool used to print every fact of every category — 8.7 million characters without a filter on the
 * live DB, up to 1.6 million with a domain filter. It now answers in levels: no filter → domains and their
 * largest categories with fact counts; a `category` filter (or facts_per_category) → the top facts of the
 * matching categories. Every level is bounded (categories per domain, facts per category, characters per
 * fact, characters in total) and says what it left out and which filter reaches it.
 */

/** Most characters one answer carries (the closing note comes on top). */
export const ONTOLOGY_MAX_OUTPUT_CHARS = 20_000;
/** Characters of one fact line — the full text is one search_facts away. */
export const ONTOLOGY_FACT_CHARS = 300;
/** Facts shown per category when a `category` filter is given and facts_per_category is not. */
export const ONTOLOGY_DEFAULT_FACTS_PER_CATEGORY = 5;
/** Categories listed per domain: without / with facts. */
export const ONTOLOGY_DEFAULT_CATEGORIES_OVERVIEW = 8;
export const ONTOLOGY_DEFAULT_CATEGORIES_WITH_FACTS = 20;
/**
 * Categories whose facts are loaded for one answer. A category block is at least ~130 characters, so no
 * more than this many can fit under the output ceiling whatever the caller asks for.
 */
const FACT_CATEGORY_LOAD_CAP = 150;

export interface OntologyBrowseParams {
  domain?: string;
  category?: string;
  include_relations?: boolean;
  /** Facts shown per category (0 = names and counts only). Default: 5 with a `category` filter, else 0. */
  facts_per_category?: number;
  /** Categories listed per domain, largest first. Default: 8 without facts, 20 with. */
  max_categories?: number;
}

type CategoryEntry = DomainTree['categories'][number];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const sum = (entries: CategoryEntry[]) => entries.reduce((total, entry) => total + entry.factCount, 0);

export function formatOntologyBrowse(db: Database.Database, params: OntologyBrowseParams): string {
  const factsPerCategory = params.facts_per_category ?? (params.category ? ONTOLOGY_DEFAULT_FACTS_PER_CATEGORY : 0);
  const withFacts = factsPerCategory > 0;
  const maxCategories = params.max_categories
    ?? (withFacts ? ONTOLOGY_DEFAULT_CATEGORIES_WITH_FACTS : ONTOLOGY_DEFAULT_CATEGORIES_OVERVIEW);

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
        .sort((a, b) => b.factCount - a.factCount || a.category.name.localeCompare(b.category.name));
      return {
        domain,
        listed: nonEmpty.slice(0, maxCategories),
        rest: nonEmpty.slice(maxCategories),
        categoryCount: nonEmpty.length,
        emptyCount: categories.length - nonEmpty.length,
        factCount: sum(nonEmpty),
      };
    })
    .sort((a, b) => b.factCount - a.factCount || a.domain.name.localeCompare(b.domain.name));

  const totalCategories = domains.reduce((n, d) => n + d.categoryCount, 0);
  const totalFacts = domains.reduce((n, d) => n + d.factCount, 0);
  output += `${plural(domains.length, 'domain', 'domains')} · ${plural(totalCategories, 'category', 'categories')} · ${plural(totalFacts, 'active fact', 'active facts')}`;
  if (params.domain || params.category) output += ' match the filter';
  output += '\n\n';

  // Facts for the categories that can be shown, in display order — one ranked query, not one per category.
  const factsByCategory = new Map<string, CategoryEntry['facts']>();
  if (withFacts) {
    const ids = domains.flatMap((d) => d.listed.map((entry) => entry.category.id)).slice(0, FACT_CATEGORY_LOAD_CAP);
    if (ids.length > 0) {
      for (const { categories } of getOntologyTree(db, { categoryIds: ids, factsPerCategory })) {
        for (const entry of categories) factsByCategory.set(entry.category.id, entry.facts);
      }
    }
  }

  const categoryBlock = (entry: CategoryEntry): string => {
    if (!withFacts) return `- ${entry.category.name} (${entry.factCount})\n`;

    let block = `### ${entry.category.name}`;
    if (entry.category.description) block += ` — ${clipLine(entry.category.description, ONTOLOGY_FACT_CHARS)}`;
    const facts = factsByCategory.get(entry.category.id) ?? [];
    block += `\n(${plural(entry.factCount, 'fact', 'facts')}${facts.length < entry.factCount ? `, top ${facts.length} shown` : ''})\n\n`;
    for (const fact of facts) {
      block += `- **[${fact.category}]** ${clipLine(fact.fact, ONTOLOGY_FACT_CHARS)}\n`;
      block += `  - ID: ${fact.id} | Confirmed: ${fact.consolidated_count}x | ${fact.created_at.slice(0, 10)}\n`;
      if (params.include_relations) {
        const related = summarizeRelated(getRelatedFacts(db, fact.id, 1));
        for (const rel of related.shown) block += `  - ↔ [${rel.relationType}] "${rel.text}"\n`;
        if (related.omitted > 0) block += `  - _…and ${related.omitted} more related facts (explore_graph lists them)._\n`;
      }
    }
    if (facts.length < entry.factCount) {
      block += `- _…and ${entry.factCount - facts.length} more facts — raise \`facts_per_category\` or use search_facts._\n`;
    }
    return block + '\n';
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
    if (d.domain.description) header += `> ${clipLine(d.domain.description, ONTOLOGY_FACT_CHARS)}\n`;
    header += '\n';
    if (output.length + header.length > ONTOLOGY_MAX_OUTPUT_CHARS) {
      full = true;
      cutDomains++;
      cutCategories += d.categoryCount;
      cutFacts += d.factCount;
      continue;
    }
    output += header;

    let listedHere = 0;
    for (const entry of d.listed) {
      const block = full ? '' : categoryBlock(entry);
      if (full || output.length + block.length > ONTOLOGY_MAX_OUTPUT_CHARS) {
        full = true;
        cutCategories++;
        cutFacts += entry.factCount;
        continue;
      }
      output += block;
      listedHere++;
    }

    if (full) {
      cutCategories += d.rest.length;
      cutFacts += sum(d.rest);
      if (listedHere < d.categoryCount) cutDomains++;
      continue;
    }

    const tail: string[] = [];
    if (d.rest.length > 0) {
      tail.push(`- _…and ${plural(d.rest.length, 'more category', 'more categories')} (${plural(sum(d.rest), 'fact', 'facts')}) — narrow with \`category\` or raise \`max_categories\`._`);
    }
    if (d.emptyCount > 0) {
      tail.push(`- _${plural(d.emptyCount, 'empty category', 'empty categories')} not listed._`);
    }
    if (tail.length > 0) output += tail.join('\n') + '\n';
    if (!withFacts || tail.length > 0) output += '\n';
  }

  if (full) {
    output += `---\n_Output limit (${ONTOLOGY_MAX_OUTPUT_CHARS} chars) reached: ${plural(cutCategories, 'category', 'categories')} `
      + `(${plural(cutFacts, 'fact', 'facts')}) in ${plural(cutDomains, 'domain', 'domains')} not shown — narrow the \`domain\` / \`category\` filter._\n`;
  } else if (!withFacts) {
    output += '---\n_Names and counts only. Pass `domain` to list more of one domain\'s categories, `category` to read the top facts of the matching categories (`facts_per_category` sets how many)._\n';
  }

  return output;
}

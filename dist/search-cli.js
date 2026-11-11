import { searchConversationsDetailed, formatResults, searchMultipleConcepts, formatMultiConceptResults } from './search.js';
import { parseSearchArgs, SEARCH_USAGE } from './search-cli-args.js';
let parsed;
try {
    parsed = parseSearchArgs(process.argv.slice(2));
}
catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    console.error('Usage: memory-bank search [OPTIONS] <query> [query2] [query3]...');
    console.error('Try: memory-bank search --help');
    process.exit(1);
}
if (parsed.kind === 'help') {
    console.log(SEARCH_USAGE);
    process.exit(0);
}
const { mode, limit, after, before, includeNoise, queries } = parsed;
// Multi-concept search if multiple queries provided
if (queries.length > 1) {
    const options = { limit, after, before, include_noise: includeNoise };
    searchMultipleConcepts(queries, options)
        .then(async (results) => {
        console.log(await formatMultiConceptResults(results, queries));
    })
        .catch(error => {
        console.error('Error searching:', error);
        process.exit(1);
    });
}
else {
    // Single query - use regular search
    const options = {
        mode,
        limit,
        after,
        before,
        include_noise: includeNoise,
    };
    searchConversationsDetailed(queries[0], options)
        .then(async ({ results, meta }) => {
        console.log(await formatResults(results, meta));
    })
        .catch(error => {
        console.error('Error searching:', error);
        process.exit(1);
    });
}

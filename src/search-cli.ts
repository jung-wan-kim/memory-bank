import { searchConversations, formatResults, searchMultipleConcepts, formatMultiConceptResults, SearchOptions } from './search.js';
import { parseSearchArgs, SearchArgError, SEARCH_HELP_TEXT } from './search-args.js';

const args = process.argv.slice(2);

const parsed = (() => {
  try {
    return parseSearchArgs(args);
  } catch (error) {
    if (error instanceof SearchArgError) {
      console.error(error.message);
      console.error('Try: memory-bank search --help');
      process.exit(2);
    }
    throw error;
  }
})();

if (parsed.help) {
  console.log(SEARCH_HELP_TEXT);
  process.exit(0);
}

const { mode, after, before, limit, project, queries } = parsed;

if (queries.length === 0) {
  console.error('Usage: memory-bank search [OPTIONS] <query> [query2] [query3]...');
  console.error('Try: memory-bank search --help');
  process.exit(1);
}

// Multi-concept search if multiple queries provided
if (queries.length > 1) {
  const options = { limit, after, before, project };

  searchMultipleConcepts(queries, options)
    .then(async results => {
      console.log(await formatMultiConceptResults(results, queries));
    })
    .catch(error => {
      console.error('Error searching:', error);
      process.exit(1);
    });
} else {
  // Single query - use regular search
  const options: SearchOptions = {
    mode,
    limit,
    after,
    before,
    project
  };

  searchConversations(queries[0], options)
    .then(async results => {
      console.log(await formatResults(results));
    })
    .catch(error => {
      console.error('Error searching:', error);
      process.exit(1);
    });
}


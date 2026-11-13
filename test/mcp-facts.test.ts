import { describe, it, expect } from 'vitest';
import fs from 'fs';

describe('MCP Facts Tool', () => {
  it('should have search_facts tool defined in server-core.ts', () => {
    const content = fs.readFileSync('src/server-core.ts', 'utf-8');
    expect(content).toContain("name: 'search_facts'");
    expect(content).toContain('Search extracted facts');
  });

  it('should have SearchFactsInputSchema defined', () => {
    const content = fs.readFileSync('src/server-core.ts', 'utf-8');
    expect(content).toContain('SearchFactsInputSchema');
  });

  it('should import fact-db functions', () => {
    // The fact tools' text is built in facts-tool.ts (testable — mcp-server.ts starts the server on import).
    const server = fs.readFileSync('src/server-core.ts', 'utf-8');
    expect(server).toContain("from './facts-tool.js'");
    expect(server).toContain('formatFactSearch(');
    const content = fs.readFileSync('src/facts-tool.ts', 'utf-8');
    expect(content).toContain('searchFactsFiltered');
    expect(content).toContain('getRevisions');
  });

  it('should handle search_facts in CallTool handler', () => {
    const content = fs.readFileSync('src/server-core.ts', 'utf-8');
    expect(content).toContain("name === 'search_facts'");
  });
});

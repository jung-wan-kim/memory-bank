// Stand-in for @anthropic-ai/claude-agent-sdk in spawned scripts: records what
// query() was called with (one JSON line per call in FAKE_AGENT_SDK_CAPTURE) and
// answers FAKE_AGENT_SDK_RESULT. No CLI is spawned and nothing leaves the machine.
import fs from 'node:fs';

export function query(args) {
  fs.appendFileSync(process.env.FAKE_AGENT_SDK_CAPTURE, JSON.stringify({ prompt: args.prompt, options: args.options }) + '\n');
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'result', subtype: 'success', result: process.env.FAKE_AGENT_SDK_RESULT ?? '' };
    },
  };
}

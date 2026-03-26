---
name: show-memory-bank
description: Launch Memory Bank web dashboard to visualize conversations, facts, and search history
---

# Show Memory Bank Dashboard

Launch the Memory Bank 3D Knowledge Graph with live data.

## Instructions

**Always restart the server** to ensure latest code is served. Pass ANTHROPIC_API_KEY for translation support:

```bash
kill $(lsof -ti:3847) 2>/dev/null
sleep 1
CLAUDE_PLUGIN_ROOT="/Users/jung-wankim/Project/Claude/memory-bank" ANTHROPIC_API_KEY="$(cat ~/.claude/.credentials 2>/dev/null || echo '')" node "/Users/jung-wankim/Project/Claude/memory-bank/ui/server.cjs" &
sleep 1
open "http://localhost:3847"
```

If ANTHROPIC_API_KEY is not available from credentials file, try extracting it from environment or ask the user to provide it.

Report to the user that the dashboard is open at http://localhost:3847.

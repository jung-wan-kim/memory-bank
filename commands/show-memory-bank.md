---
name: show-memory-bank
description: Launch Memory Bank web dashboard to visualize conversations, facts, and search history
---

# Show Memory Bank Dashboard

Launch the Memory Bank 3D Knowledge Graph with live data.

## Instructions

**Always restart the server** to ensure latest code is served:

```bash
kill $(lsof -ti:3847) 2>/dev/null
sleep 1
CLAUDE_PLUGIN_ROOT="/Users/jung-wankim/Project/Claude/memory-bank" node "/Users/jung-wankim/Project/Claude/memory-bank/ui/server.cjs" &
sleep 1
open "http://localhost:3847"
```

Report to the user that the dashboard is open at http://localhost:3847.

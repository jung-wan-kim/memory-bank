---
name: show-memory-bank
description: Launch Memory Bank web dashboard to visualize conversations, facts, and search history
---

# Show Memory Bank Dashboard

Launch the Memory Bank 3D Knowledge Graph with live data.

## Instructions

**Always restart the dashboard server**, so the one serving the page is the installed plugin version:

1. **Stop a dashboard server that is still running.** This stops that server only; when nothing matches, nothing was running:
   ```bash
   pkill -f "ui/server.cjs"
   ```

2. **Start the server from the plugin and open the browser:**
   ```bash
   CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}" node "${CLAUDE_PLUGIN_ROOT}/ui/server.cjs" &
   sleep 1
   open "http://localhost:3847"
   ```

3. **If the server prints `Memory Bank UI not started`** (for example another program holds port 3847), show that line to the user and stop there — do not stop the other program. `PORT=<number>` in front of the `node` command starts the dashboard on another port.

4. **Report to the user** that the dashboard is open at http://localhost:3847 — the 3D graph at `/`, the list view at `/dashboard` — and that `pkill -f "ui/server.cjs"` stops it.

No API key is needed: the dashboard translates through the Claude Agent SDK, with the account Claude Code is signed in to.

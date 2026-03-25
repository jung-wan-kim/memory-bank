---
name: show-memory-bank
description: Launch Memory Bank web dashboard to visualize conversations, facts, and search history
---

# Show Memory Bank Dashboard

Launch the Memory Bank web UI to visually explore your conversation archive.

## Instructions

Run the following steps:

1. **Check if server is already running** on port 3847:
   ```bash
   lsof -ti:3847 2>/dev/null
   ```

2. **If a server is already running**, just open the browser:
   ```bash
   open "http://localhost:3847"
   ```

3. **If no server is running**, start the web UI server in the background and open the browser:
   ```bash
   CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}" node "${CLAUDE_PLUGIN_ROOT}/ui/server.cjs" &
   sleep 1
   open "http://localhost:3847"
   ```

4. **Report to the user:**
   - Tell them the dashboard is now open at http://localhost:3847
   - Mention they can stop the server with: `kill $(lsof -ti:3847)` or simply close the terminal
   - The dashboard shows: projects, conversation search, user prompts, and fact search

## Features Available in the Dashboard

- **Projects tab**: Browse all indexed projects with stats and last prompt
- **Search tab**: Full-text search across all conversations
- **User Prompts tab**: View user messages filtered by quality
- **Fact Search tab**: Search extracted decisions, preferences, patterns
- **Exchange Detail**: Click any result to see full user/assistant/tool messages

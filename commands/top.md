---
description: Show your top-rated agent sessions
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/sessionboard.mjs" top`

Show the leaderboard above to the user as-is. If it says AI rating is off, tell them to run `node "${CLAUDE_PLUGIN_ROOT}/bin/sessionboard.mjs" init` in a terminal (it asks a couple of setup questions).

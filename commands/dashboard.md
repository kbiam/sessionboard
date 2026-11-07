---
description: Open the sessionboard dashboard in your browser
allowed-tools: Bash(node:*)
---
Start the dashboard in the background with the Bash tool (`run_in_background: true`):

`node "${CLAUDE_PLUGIN_ROOT}/bin/sessionboard.mjs" dashboard`

It opens http://localhost:4317 (or the next free port) in the browser. Tell the user the URL from its output, and that it stops when this session ends.

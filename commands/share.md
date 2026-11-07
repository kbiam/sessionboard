---
description: Export one of your top sessions as a redacted, shareable page (default rank 1)
argument-hint: "[rank|session-id] [--html] [--copy] [--gist]"
allowed-tools: Bash(node:*)
---
Run this and report the output path to the user:

`node "${CLAUDE_PLUGIN_ROOT}/bin/sessionboard.mjs" share $ARGUMENTS`

If no format flag was given, add `--html`. Only pass `--gist` if the user explicitly asked for a gist, since it uploads to GitHub. Remind them to skim the export before sending it; redaction catches common secrets, not everything.

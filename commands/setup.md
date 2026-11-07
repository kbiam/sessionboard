---
description: Set up sessionboard - choose the judge model and settings, then rate your sessions
allowed-tools: Bash(node:*), AskUserQuestion
---
Current state:
!`node "${CLAUDE_PLUGIN_ROOT}/bin/sessionboard.mjs" setup-info`

Walk the user through setup. Briefly explain first, in 2-3 lines: when a session ends, a background hook gives it one AI rating (0-10, with a summary and the reason), the best sessions make their board, and any session can be exported as a redacted page to share.

Then ask with AskUserQuestion, preselecting the user's current values where the state above shows them (otherwise put the recommended option first):

Call 1 (four questions):
1. "Which model should judge your sessions?" - Haiku (Recommended: fast, cheapest) / Sonnet (sharper, ~3x cost) / Opus (best, slowest) / Off (free heuristic only)
2. "When should a resumed session be re-rated?" - When it grows 25% (Recommended) / When it doubles / Never
3. "How big is your board?" - Top 3 (Recommended) / Top 5 / Top 10
4. "Which sessions count?" - Standard: 2+ prompts and 5+ tool calls (Recommended) / Strict: 5+ prompts and 20+ tool calls / Everything

Call 2 (ask only the questions that apply):
5. Only if cleanupPeriodDays is under 365: "Claude Code deletes transcripts older than N days, so older sessions drop off your board. Keep them longer? This edits ~/.claude/settings.json." - Keep for 10 years (Recommended) / Keep for 1 year / Leave as is
6. Only if hookInstalled is false: "Rate sessions automatically when they end? This adds one hook to ~/.claude/settings.json." - Yes (Recommended) / No, I'll refresh myself
7. "Words to hide in exports, like company, product, client or internal host names?" - None / Type them (via Other, comma-separated)
8. "Redact email addresses in exports?" - Yes (Recommended) / No

Then apply exactly what they chose. Only pass --retention and --hook=yes if they explicitly picked those options:

`node "${CLAUDE_PLUGIN_ROOT}/bin/sessionboard.mjs" setup-apply --judgeModel=<haiku|sonnet|opus|off> --rejudgeGrowth=<1.25|2|0> --topN=<3|5|10> --minPrompts=<2|5|1> --minToolCalls=<5|20|1> --redactEmails=<true|false> --redactTerms="<comma,separated or empty>" --retention=<3650|365|keep> --hook=<yes|no>`

If the judge is on and there are unrated sessions, rate them (one call per session, roughly 8 seconds each; tell the user it's running):

`node "${CLAUDE_PLUGIN_ROOT}/bin/sessionboard.mjs" update`

Finish by running `node "${CLAUDE_PLUGIN_ROOT}/bin/sessionboard.mjs" top` and showing the board as-is, then mention /sessionboard:dashboard and /sessionboard:share 1.

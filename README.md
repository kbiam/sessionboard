# sessionboard

Companies now ask you to share your best AI agent session. After hundreds of chats, which one was it?

**sessionboard** rates each Claude Code session with an AI judge when it ends, keeps your top sessions on a board, and exports any of them as a clean, redacted page you can share.

```
  #1  Activity feed for the admin dashboard
      ████████░░ 7.8/10   2026-10-11 · ~/code/my-app
      Built and shipped an activity feed across backend and frontend,
      with tests passing and both repos pushed.
      256 tool calls · 12 files changed · 53 test/build runs · 12 commits
```

## Install

As a Claude Code plugin:

```
/plugin marketplace add kbiam/sessionboard
/plugin install sessionboard@sessionboard
/sessionboard:setup
```

Or as a CLI:

```bash
npm install -g sessionboard
sessionboard init
```

Setup asks a few questions (judge model, board size, words to hide) and asks before it changes any Claude Code settings. Both routes share one rating hook: if one is already installed, setup leaves it alone, so installing both never rates a session twice.

## Usage

```bash
sessionboard dashboard        # open the dashboard at localhost:4317
sessionboard top              # show your top sessions
sessionboard share 1 --html   # export your #1 session as a redacted page
sessionboard config           # change settings
sessionboard uninstall        # remove the rating hook
```

Inside Claude Code: `/sessionboard:setup`, `/sessionboard:dashboard`, `/sessionboard:top`, `/sessionboard:share 1`.

## How it works

1. You close a session, and a hook picks it up in the background.
2. Sessions with fewer than 2 prompts or 5 tool calls are skipped.
3. An AI judge (Haiku by default) scores the session 0–10, with a one-line summary and reason.
4. The highest-scoring sessions make your board. A resumed session is re-rated once it grows 25%.

Everything runs locally. The only network call is the judge, which uses your existing Claude Code login.

## Privacy

Exports remove API keys, tokens, passwords, private keys, emails, your home path, and any words you choose to hide (company, client, internal hostnames). Tool output and thinking are left out by default.

Redaction catches common patterns, not everything, so read an export before you share it.

## Requirements

Node 18+ and [Claude Code](https://claude.com/claude-code).

## License

MIT

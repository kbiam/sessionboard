#!/usr/bin/env node
// sessionboard: an LLM-judged leaderboard of your Claude Code sessions, with redacted sharing and a local dashboard.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const SELF = fileURLToPath(import.meta.url);
const ROOT = path.dirname(path.dirname(SELF));
const CLAUDE_DIR = path.join(HOME, '.claude');
const CLAUDE_SETTINGS = process.env.SESSIONBOARD_CLAUDE_SETTINGS || path.join(CLAUDE_DIR, 'settings.json');
const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR || path.join(CLAUDE_DIR, 'projects');
const DATA_DIR = process.env.SESSIONBOARD_HOME || path.join(HOME, '.sessionboard');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const TOP_FILE = path.join(DATA_DIR, 'TOP3.md');
const EXPORT_DIR = path.join(DATA_DIR, 'exports');
const LOCK_FILE = path.join(DATA_DIR, 'index.lock');
const CHILD_ENV = 'SESSIONBOARD_CHILD';
const PARSER_VERSION = 1;
const KEEP_FOREVER_DAYS = 3650;

const DEFAULT_CONFIG = {
  initialized: false,
  topN: 3,
  judge: true,
  judgeModel: 'haiku',
  rejudgeGrowth: 1.25,      // re-judge a resumed session once its transcript grows this much
  redactEmails: true,
  redactTerms: [],          // your own words to hide in exports: company, product, client, internal hosts
  minPrompts: 2,
  minToolCalls: 5,
  port: 4317,
};

// ---------- utils ----------

const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
const logScale = (x, cap) => clamp(Math.log1p(x) / Math.log1p(cap));
const readJSON = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJSON = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(v, null, 2)); fs.renameSync(tmp, f); };
const loadConfig = () => ({ ...DEFAULT_CONFIG, ...readJSON(CONFIG_FILE, {}) });
const saveConfig = (patch) => writeJSON(CONFIG_FILE, { ...readJSON(CONFIG_FILE, {}), ...patch });
const shortId = (id) => id.slice(0, 8);
const fmtDate = (iso) => iso ? new Date(iso).toISOString().slice(0, 10) : '?';
const fmtMins = (m) => { m = Math.round(m); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };
const tildify = (p) => p ? p.split(HOME).join('~') : p;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ---------- terminal UI ----------

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s);
const bold = paint('1'), dim = paint('2'), accent = paint('38;5;173'), green = paint('32'), yellow = paint('33'), red = paint('31');
const visLen = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '').length;
const padEnd = (s, n) => s + ' '.repeat(Math.max(0, n - visLen(s)));

function box(lines, { title = '', width = 66 } = {}) {
  const inner = Math.max(width, ...lines.map((l) => visLen(l) + 2), visLen(title) + 6);
  const top = title ? `${dim('╭─ ')}${bold(title)}${dim(` ${'─'.repeat(inner - visLen(title) - 3)}╮`)}` : dim(`╭${'─'.repeat(inner)}╮`);
  return [top, ...lines.map((l) => `${dim('│')} ${padEnd(l, inner - 2)} ${dim('│')}`), dim(`╰${'─'.repeat(inner)}╯`)].map((l) => `  ${l}`).join('\n');
}

const scoreBar = (score, width = 10) => {
  const filled = Math.round(clamp(score / 10) * width);
  return accent('█'.repeat(filled)) + dim('░'.repeat(width - filled));
};
const medal = (rank) => [null, yellow, (s) => bold(s), accent][rank]?.(`#${rank}`) ?? dim(`#${rank}`);

// Arrow-key picker. Falls back to `fallback` (or the default) when there is no terminal to ask.
function select(question, options, { def = 0, fallback } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(options[fallback ?? def].value);
  return new Promise((resolve) => {
    let i = def;
    const lines = () => options.map((o, k) => k === i
      ? `  ${accent('❯')} ${bold(o.label)}${o.hint ? `  ${dim(o.hint)}` : ''}`
      : `    ${o.label}${o.hint ? `  ${dim(o.hint)}` : ''}`);
    const draw = (first) => {
      if (!first) process.stdout.write(`\x1b[${options.length}A\x1b[0J`);
      process.stdout.write(`${lines().join('\n')}\n`);
    };
    process.stdout.write(`\n  ${accent('?')} ${bold(question)}  ${dim('↑↓ to move · enter to pick')}\n`);
    draw(true);
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onKey = (_, key = {}) => {
      if (key.ctrl && key.name === 'c') { process.stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); }
      if (key.name === 'up' || key.name === 'k') { i = (i - 1 + options.length) % options.length; draw(); }
      else if (key.name === 'down' || key.name === 'j') { i = (i + 1) % options.length; draw(); }
      else if (key.name === 'return' || key.name === 'enter') {
        process.stdin.off('keypress', onKey);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write(`\x1b[${options.length + 1}A\x1b[0J  ${green('✔')} ${question}  ${accent(options[i].label)}\n`);
        resolve(options[i].value);
      }
    };
    process.stdin.on('keypress', onKey);
  });
}

// Free-text prompt. Returns `fallback` when there is no terminal to ask.
function input(question, { initial = '', hint = '', fallback = initial } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(fallback);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  if (hint) process.stdout.write(`\n  ${dim(hint)}`);
  return new Promise((resolve) => {
    rl.question(`\n  ${accent('?')} ${bold(question)}\n  ${accent('›')} `, (answer) => {
      rl.close();
      process.stdout.write(`\x1b[2A\x1b[0J  ${green('✔')} ${question}  ${accent(answer.trim() || 'none')}\n`);
      resolve(answer.trim());
    });
    if (initial) rl.write(initial);
  });
}

function spinner(text) {
  if (!process.stdout.isTTY) { process.stdout.write(`  ${text}\n`); return { stop: (final) => process.stdout.write(`  ${final}\n`) }; }
  const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
  let f = 0;
  const t = setInterval(() => process.stdout.write(`\r\x1b[2K  ${accent(frames[f++ % frames.length])} ${text}`), 80);
  return { stop: (final) => { clearInterval(t); process.stdout.write(`\r\x1b[2K  ${final}\n`); } };
}

function listSessionFiles() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  const out = [];
  for (const proj of fs.readdirSync(PROJECTS_DIR)) {
    let entries;
    try { entries = fs.readdirSync(path.join(PROJECTS_DIR, proj), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path.join(PROJECTS_DIR, proj, e.name));
  }
  return out;
}

function* readLines(file) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* partial line from a live session */ }
  }
}

// Text of a real, human-typed prompt, or null for meta/tool-result/command noise.
function promptText(entry) {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain) return null;
  const c = entry.message?.content;
  if (Array.isArray(c) && c.some((b) => b.type === 'tool_result')) return null;
  const text = (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '').trim();
  if (!text || /^<(local-command|command-name|command-message|system-reminder|task-notification)/.test(text) || text.startsWith('Caveat:')) return null;
  return text;
}

// ---------- parsing & heuristic score (free, no LLM; used for gating and tie-breaks) ----------

const POSITIVE = /\b(thanks|thank you|thx|perfect|awesome|amazing|great job|great work|love it|love this|works now|it works|working now|nice|excellent|brilliant|exactly what|beautiful|wow|lgtm|ship it)\b/i;
const NEGATIVE = /\b(wrong|not working|doesn'?t work|didn'?t work|still (broken|failing|not)|broken|wtf|ugh|undo|revert|that'?s not|you broke|why did you|useless|terrible)\b/i;
const TEST_CMD = /\b((npm|pnpm|yarn|bun)( run)? (test|build|lint|typecheck|check)|npx (tsc|jest|vitest|playwright|eslint)|pytest|jest|vitest|playwright test|go (test|build|vet)|cargo (test|build|check|clippy)|tsc( |$)|eslint|ruff|mypy|make (test|build|check)|gradlew? (test|build)|mvn (test|verify|package)|rspec|phpunit|dotnet (test|build))\b/i;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function parseSession(file) {
  const s = {
    id: path.basename(file, '.jsonl'), file, title: null, cwd: null, branch: null, model: null,
    start: null, end: null, activeMinutes: 0,
    prompts: 0, interrupts: 0, positive: 0, negative: 0, praise: null, firstPrompt: null,
    toolCalls: 0, toolErrors: 0, toolResults: 0, tools: {}, filesChanged: [],
    testRuns: 0, commits: 0, prs: 0, outputTokens: 0,
  };
  const files = new Set();
  const seenMsg = new Set();
  let customTitle = false;
  let lastTs = null;

  for (const e of readLines(file)) {
    if (e.type === 'custom-title' && e.customTitle) { s.title = e.customTitle; customTitle = true; }
    else if (e.type === 'ai-title' && e.aiTitle && !customTitle) s.title = e.aiTitle;
    else if (e.type === 'summary' && e.summary && !s.title) s.title = e.summary;
    if (e.isSidechain) continue;
    if (e.cwd && !s.cwd) s.cwd = e.cwd;
    if (e.gitBranch && e.gitBranch !== 'HEAD') s.branch = e.gitBranch;

    if (e.timestamp) {
      const t = Date.parse(e.timestamp);
      if (!Number.isNaN(t)) {
        if (!s.start) s.start = e.timestamp;
        s.end = e.timestamp;
        if (lastTs && t > lastTs && t - lastTs < 10 * 60e3) s.activeMinutes += (t - lastTs) / 60e3;
        lastTs = t;
      }
    }

    if (e.type === 'user') {
      const c = e.message?.content;
      if (Array.isArray(c)) for (const b of c) {
        if (b.type === 'tool_result') { s.toolResults++; if (b.is_error) s.toolErrors++; }
        if (b.type === 'text' && /^\[Request interrupted by user/.test(b.text || '')) s.interrupts++;
      }
      const text = promptText(e);
      if (text && !/^\[Request interrupted by user/.test(text)) {
        s.prompts++;
        if (!s.firstPrompt) s.firstPrompt = text.slice(0, 200);
        if (POSITIVE.test(text)) { s.positive++; if (text.length < 80) s.praise = text; }
        if (NEGATIVE.test(text)) s.negative++;
      }
    }

    if (e.type === 'assistant' && e.message) {
      const m = e.message;
      if (m.model && !m.model.startsWith('<')) s.model = m.model;
      if (m.id && !seenMsg.has(m.id)) { seenMsg.add(m.id); s.outputTokens += m.usage?.output_tokens || 0; }
      for (const b of m.content || []) {
        if (b.type !== 'tool_use') continue;
        s.toolCalls++;
        const name = b.name?.startsWith('mcp__') ? b.name.split('__').slice(0, 2).join('__') : b.name;
        s.tools[name] = (s.tools[name] || 0) + 1;
        const inp = b.input || {};
        if (EDIT_TOOLS.has(b.name) && (inp.file_path || inp.notebook_path)) files.add(inp.file_path || inp.notebook_path);
        if (b.name === 'Bash' && typeof inp.command === 'string') {
          if (TEST_CMD.test(inp.command)) s.testRuns++;
          if (/\bgit commit\b/.test(inp.command)) s.commits++;
          if (/\bgh pr create\b/.test(inp.command)) s.prs++;
        }
      }
    }
  }
  s.filesChanged = [...files].map(tildify);
  return s;
}

function heuristicScore(s) {
  const parts = {
    depth: [18, logScale(s.toolCalls, 150)],
    output: [18, logScale(s.filesChanged.length, 25)],
    verification: [14, clamp((s.testRuns > 0 ? 0.55 : 0) + (s.commits > 0 ? 0.3 : 0) + (s.prs > 0 ? 0.15 : 0))],
    sentiment: [14, clamp(0.5 + 0.18 * s.positive - 0.15 * s.negative - 0.08 * s.interrupts)],
    engagement: [10, logScale(s.prompts, 30)],
    autonomy: [10, clamp(s.toolCalls / Math.max(1, s.prompts) / 15)],
    breadth: [8, clamp(Object.keys(s.tools).length / 8)],
    reliability: [8, s.toolResults ? 1 - s.toolErrors / s.toolResults : 0.5],
  };
  return Math.round(Object.values(parts).reduce((t, [w, v]) => t + w * v, 0) * 10) / 10;
}

function highlights(s) {
  const h = [`${s.toolCalls} tool calls`];
  if (s.filesChanged.length) h.push(`${s.filesChanged.length} files changed`);
  if (s.testRuns) h.push(`${s.testRuns} test/build runs`);
  if (s.commits) h.push(`${s.commits} commit${s.commits > 1 ? 's' : ''}`);
  if (s.prs) h.push(`${s.prs} PR${s.prs > 1 ? 's' : ''}`);
  h.push(`${s.prompts} prompts`, `${fmtMins(s.activeMinutes)} active`);
  return h.join(' · ');
}

// ---------- LLM judge: one absolute 0-10 score per session ----------

const JUDGE_RUBRIC = `You are scoring one Claude Code (AI coding agent) session for a "best agent sessions" portfolio - the kind a developer shares with a hiring company to show how well they work with AI agents.

Score it 0-10 against this fixed scale, using one decimal place to separate sessions within a band (use the whole range; most sessions are 4-7):
  9-10  Hard, real-world task (substantial feature, tricky bug, system design), clearly directed by the human, verified with tests/builds/checks, clearly shipped.
  7-8   Solid feature or fix, mostly clean execution, verified, goal achieved.
  4-6   Useful but simple, OR a real task with lots of thrashing/back-and-forth, OR outcome unclear.
  0-3   Trivial, aimless, chit-chat, mostly setup noise, or the goal failed.

Weigh: task difficulty and real-world value; quality of the human's direction (clear goals, decomposition, catching mistakes); the agent's execution (correct, verified, little thrashing); outcome.

Reply with ONLY a JSON object, no prose, no code fences:
{"score": <number 0-10, one decimal>, "summary": "<one sentence: what was accomplished>", "reason": "<one sentence, max 25 words: why this score>"}

TRANSCRIPT DIGEST:
`;

function digest(file, maxChars = 14000) {
  const lines = [];
  for (const e of readLines(file)) {
    if (e.isSidechain) continue;
    const text = promptText(e);
    if (text) { lines.push(`USER: ${text.slice(0, 1200)}`); continue; }
    if (e.type === 'assistant') for (const b of e.message?.content || []) {
      if (b.type === 'text' && b.text?.trim()) lines.push(`AGENT: ${b.text.trim().slice(0, 600)}`);
      else if (b.type === 'tool_use') lines.push(`  [tool ${b.name}] ${toolOneLiner(b).slice(0, 140)}`);
    }
    if (e.type === 'user' && Array.isArray(e.message?.content))
      for (const b of e.message.content) if (b.type === 'tool_result' && b.is_error) lines.push('  [tool error]');
  }
  let out = lines.join('\n');
  if (out.length > maxChars) out = `${out.slice(0, maxChars * 0.45)}\n\n[... middle omitted ...]\n\n${out.slice(-maxChars * 0.55)}`;
  return redact(out, { emails: true });
}

function judgeSession(file, model) {
  const args = [
    '-p', '--model', model, '--no-session-persistence', '--tools', '', '--output-format', 'text',
    // The judge is itself a Claude Code process; keep it from running the transcript cleanup on startup.
    '--settings', JSON.stringify({ cleanupPeriodDays: KEEP_FOREVER_DAYS }),
  ];
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd: DATA_DIR, env: { ...process.env, [CHILD_ENV]: '1' } });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('judge timed out')); }, 180e3);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error((err || `exit ${code}`).trim().slice(0, 200)));
      try {
        const j = JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] ?? 'null');
        if (!j) throw new Error('judge returned no JSON');
        resolve({ score: Math.round(clamp(Number(j.score), 0, 10) * 10) / 10, summary: String(j.summary || ''), reason: String(j.reason || '') });
      } catch (e) { reject(e); }
    });
    child.stdin.end(JUDGE_RUBRIC + digest(file));
  });
}

// ---------- index (shared by CLI, hook jobs and the dashboard) ----------

function withIndex(fn) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const deadline = Date.now() + 60e3;
  for (;;) {
    try { fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' }); break; } catch {
      try { if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > 120e3) fs.unlinkSync(LOCK_FILE); } catch {}
      if (Date.now() > deadline) throw new Error(`index is locked (${LOCK_FILE})`);
      sleep(100);
    }
  }
  try {
    const index = readJSON(INDEX_FILE, null) || { sessions: {}, pinned: [], hidden: [] };
    if (index.parserVersion !== PARSER_VERSION) {
      for (const s of Object.values(index.sessions)) s.mtimeMs = -1;   // force re-parse, keep judge verdicts
      index.parserVersion = PARSER_VERSION;
    }
    const result = fn(index);
    index.updatedAt = new Date().toISOString();
    writeJSON(INDEX_FILE, index);
    writeTopFile(index);
    return result;
  } finally {
    try { fs.unlinkSync(LOCK_FILE); } catch {}
  }
}
const readIndex = () => readJSON(INDEX_FILE, null) || { sessions: {}, pinned: [], hidden: [] };

// Re-parse changed transcripts. Sessions whose transcript disappeared stay on the board, marked missing.
function scan() {
  const cfg = loadConfig();
  return withIndex((index) => {
    const live = new Set();
    for (const file of listSessionFiles()) {
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      const id = path.basename(file, '.jsonl');
      live.add(id);
      const prev = index.sessions[id];
      if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size && !prev.missing) continue;
      const s = parseSession(file);
      Object.assign(s, { mtimeMs: st.mtimeMs, size: st.size, heuristic: heuristicScore(s), judge: prev?.judge, missing: false });
      s.eligible = s.prompts >= cfg.minPrompts && s.toolCalls >= cfg.minToolCalls;
      index.sessions[id] = s;
    }
    for (const s of Object.values(index.sessions)) {
      if (!live.has(s.id)) s.missing = true;
      s.eligible = s.prompts >= cfg.minPrompts && s.toolCalls >= cfg.minToolCalls;   // thresholds may have changed
    }
    return index;
  });
}

// rejudgeGrowth 0 means "never re-rate a session once it has a score".
const needsJudge = (s, cfg) => s.eligible && !s.missing && (!s.judge || (cfg.rejudgeGrowth > 0 && s.size > s.judge.atSize * cfg.rejudgeGrowth));

// Judge outside the lock (LLM calls are slow), then store the verdict under the lock.
async function judgeAndStore(id, { force = false, log = () => {} } = {}) {
  const cfg = loadConfig();
  const s = readIndex().sessions[id];
  if (!s || s.missing || (!force && !needsJudge(s, cfg))) return null;
  log(`judging ${shortId(id)} "${s.title || s.firstPrompt?.slice(0, 40) || ''}"... `);
  const verdict = { ...await judgeSession(s.file, cfg.judgeModel), atSize: s.size, model: cfg.judgeModel, at: new Date().toISOString() };
  withIndex((index) => { if (index.sessions[id]) index.sessions[id].judge = verdict; });
  log(`${verdict.score}/10\n`);
  return verdict;
}

async function judgePending({ log } = {}) {
  const cfg = loadConfig();
  const pending = Object.values(readIndex().sessions).filter((s) => needsJudge(s, cfg));
  for (const s of pending) {
    try { await judgeAndStore(s.id, { log }); } catch (err) { log?.(`failed (${err.message})\n`); }
  }
  return pending.length;
}

function ranked(index) {
  const pinned = index.pinned.map((id) => index.sessions[id]).filter(Boolean);
  const rest = Object.values(index.sessions)
    .filter((s) => s.eligible && !index.hidden.includes(s.id) && !index.pinned.includes(s.id))
    .sort((a, b) => ((b.judge?.score ?? -1) - (a.judge?.score ?? -1)) || (b.heuristic - a.heuristic));
  return [...pinned, ...rest];
}

function describe(s, i, index) {
  const tags = [index.pinned.includes(s.id) && '📌 pinned', s.missing && 'transcript deleted'].filter(Boolean).join(', ');
  const lines = [
    `${i + 1}. ${s.title || s.firstPrompt?.slice(0, 60) || '(untitled)'}${tags ? `  [${tags}]` : ''}`,
    `   ${s.judge ? `${s.judge.score}/10` : 'not judged yet'}  ·  ${fmtDate(s.start)}  ·  ${tildify(s.cwd) || '?'}  ·  id ${shortId(s.id)}`,
  ];
  if (s.judge?.summary) lines.push(`   ${s.judge.summary}`);
  if (s.judge?.reason) lines.push(`   why: ${s.judge.reason}`);
  lines.push(`   ${highlights(s)}`);
  return lines.join('\n');
}

function writeTopFile(index) {
  const cfg = loadConfig();
  const body = ranked(index).slice(0, cfg.topN).map((s, i) => describe(s, i, index)).join('\n\n');
  fs.writeFileSync(TOP_FILE, `# My top ${cfg.topN} agent sessions\n\n_Updated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · share one with \`sessionboard share <rank>\`_\n\n\`\`\`\n${body || 'No eligible sessions yet.'}\n\`\`\`\n`);
}

// ---------- redaction & export ----------

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function redact(text, { emails, terms = loadConfig().redactTerms } = {}) {
  let t = text.split(HOME).join('~');
  t = t.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
  t = t.replace(/\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|[sr]k_(?:live|test)_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, '[REDACTED]');
  t = t.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1[REDACTED]');
  t = t.replace(/\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|password|passwd|pwd)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)([^\s"'`,;]{8,})/gi, '$1[REDACTED]');
  // plain language: "password is hunter2", "pass: hunter2", "the pin was 4821"
  t = t.replace(/\b((?:password|passwd|passcode|pass|pwd|pin)\s*(?:is|was|=|:)\s*["']?)([^\s"'`,;]{4,})/gi, '$1[REDACTED]');
  t = t.replace(/(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:\s/]+:[^@\s]+@/gi, '$1://[REDACTED]@');
  // unknown token formats: long hex, or long mixed-case alphanumeric strings that look random
  t = t.replace(/\b[A-Fa-f0-9]{32,}\b/g, '[REDACTED]');
  t = t.replace(/(?<![\w/.-])[A-Za-z0-9_+-]{32,}={0,2}(?![\w/.-])/g, (m) => /\d/.test(m) && /[a-z]/.test(m) && /[A-Z]/.test(m) ? '[REDACTED]' : m);
  if (emails) t = t.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]');
  for (const term of [...(terms || [])].sort((a, b) => b.length - a.length)) if (term.trim()) t = t.replace(new RegExp(escapeRe(term.trim()), 'gi'), '[redacted]');
  return t;
}

function toolOneLiner(b) {
  const i = b.input || {};
  const v = i.command ?? i.file_path ?? i.notebook_path ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt ?? i.skill ?? '';
  return String(v).replace(/\s+/g, ' ').trim();
}

function buildTranscript(s, { thinking = false, results = false } = {}) {
  const turns = [];
  let cur = null;
  const push = (role) => { if (!cur || cur.role !== role) { cur = { role, parts: [] }; turns.push(cur); } return cur; };
  for (const e of readLines(s.file)) {
    if (e.isSidechain) continue;
    const text = promptText(e);
    if (text) { if (!/^\[Request interrupted/.test(text)) push('user').parts.push({ kind: 'text', text }); continue; }
    if (e.type === 'assistant') for (const b of e.message?.content || []) {
      if (b.type === 'text' && b.text?.trim()) push('agent').parts.push({ kind: 'text', text: b.text.trim() });
      else if (b.type === 'thinking' && thinking && b.thinking?.trim()) push('agent').parts.push({ kind: 'thinking', text: b.thinking.trim() });
      else if (b.type === 'tool_use') push('agent').parts.push({ kind: 'tool', name: b.name, text: toolOneLiner(b) });
    }
    if (e.type === 'user' && Array.isArray(e.message?.content)) for (const b of e.message.content) {
      if (b.type !== 'tool_result' || cur?.role !== 'agent') continue;
      const last = cur.parts.findLast((p) => p.kind === 'tool');
      if (!last) continue;
      if (b.is_error) last.error = true;
      if (results) {
        const c = typeof b.content === 'string' ? b.content : (b.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n');
        last.result = c.split('\n').slice(0, 12).join('\n').slice(0, 1200);
      }
    }
  }
  return turns;
}

function exportMarkdown(s, turns) {
  const out = [
    `# ${s.title || 'Claude Code session'}`, '',
    `> Claude Code session · ${fmtDate(s.start)} · ${fmtMins(s.activeMinutes)} active${s.model ? ` · ${s.model}` : ''}${s.branch ? ` · branch \`${s.branch}\`` : ''}`, '',
    `**${highlights(s)}**`, '',
  ];
  if (s.judge?.summary) out.push(`**What got done:** ${s.judge.summary}`, '');
  out.push('---', '');
  for (const t of turns) {
    out.push(t.role === 'user' ? '### 👤 Me' : '### 🤖 Claude', '');
    for (const p of t.parts) {
      if (p.kind === 'text') out.push(p.text, '');
      else if (p.kind === 'thinking') out.push(`<details><summary>thinking</summary>\n\n${p.text}\n\n</details>`, '');
      else {
        out.push(`- 🔧 **${p.name}**${p.error ? ' ⚠️' : ''} \`${p.text.slice(0, 160).replace(/`/g, "'")}\``);
        if (p.result) out.push('', '  ```', ...p.result.split('\n').map((l) => `  ${l}`), '  ```');
      }
    }
    out.push('');
  }
  out.push('---', '_Shared with [sessionboard](https://github.com/kbiam/sessionboard)_');
  return out.join('\n');
}

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const mdLite = (t) => esc(t)
  .replace(/```[\w-]*\n([\s\S]*?)```/g, (_, c) => `<pre><code>${c}</code></pre>`)
  .replace(/`([^`\n]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  .replace(/\n/g, '<br>');

function exportHTML(s, turns) {
  const body = turns.map((t) => {
    const parts = t.parts.map((p) => {
      if (p.kind === 'text') return `<div class="text">${mdLite(p.text)}</div>`;
      if (p.kind === 'thinking') return `<details class="think"><summary>thinking</summary><div>${mdLite(p.text)}</div></details>`;
      return `<div class="tool${p.error ? ' err' : ''}"><span class="tn">${esc(p.name)}</span><code>${esc(p.text.slice(0, 200))}</code>${p.result ? `<pre>${esc(p.result)}</pre>` : ''}</div>`;
    }).join('');
    return `<section class="turn ${t.role}"><div class="who">${t.role === 'user' ? 'Me' : 'Claude'}</div>${parts}</section>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(s.title || 'Agent session')}</title>
<style>
:root{--bg:#faf9f7;--fg:#1f1e1c;--mute:#6b6862;--card:#fff;--line:#e6e3dd;--accent:#c96442;--user:#f1ede6;--err:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#1a1917;--fg:#ecebe8;--mute:#9b978f;--card:#232220;--line:#35332f;--user:#2b2926;--err:#f2b8b5}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif}
main{max-width:820px;margin:0 auto;padding:40px 16px 80px}h1{font-size:28px;line-height:1.25;margin:0 0 8px}
.meta{color:var(--mute);font-size:14px}.stats{margin:16px 0;padding:12px 16px;border:1px solid var(--line);border-radius:10px;background:var(--card);font-size:14px}
.turn{margin:18px 0;padding:14px 16px;border-radius:12px;border:1px solid var(--line);background:var(--card)}.turn.user{background:var(--user)}
.who{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--accent);margin-bottom:6px}
.text{margin:6px 0;overflow-wrap:anywhere}.tool{font-size:13px;color:var(--mute);margin:4px 0;overflow-wrap:anywhere}.tool .tn{font-weight:600;margin-right:6px}.tool.err .tn{color:var(--err)}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace}pre{overflow-x:auto;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;font-size:12.5px}
details.think{color:var(--mute);font-size:13px}footer{color:var(--mute);font-size:13px;margin-top:40px;text-align:center}
</style></head><body><main>
<h1>${esc(s.title || 'Claude Code session')}</h1>
<div class="meta">Claude Code · ${fmtDate(s.start)} · ${fmtMins(s.activeMinutes)} active${s.model ? ` · ${esc(s.model)}` : ''}</div>
<div class="stats">${esc(highlights(s))}${s.judge?.summary ? `<br><strong>What got done:</strong> ${esc(s.judge.summary)}` : ''}</div>
${body}
<footer>Shared with sessionboard</footer></main></body></html>`;
}

function renderExport(s, { html = false, thinking = false, results = false, keepEmails = false } = {}) {
  if (s.missing || !fs.existsSync(s.file)) throw new Error('This transcript was deleted from ~/.claude/projects (Claude Code cleanup), so it can no longer be exported.');
  const turns = buildTranscript(s, { thinking, results });
  const raw = html ? exportHTML(s, turns) : exportMarkdown(s, turns);
  return redact(raw, { emails: keepEmails ? false : loadConfig().redactEmails });
}
const exportSlug = (s) => (s.title || shortId(s.id)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || shortId(s.id);

// ---------- Claude Code settings (only touched after the user says yes) ----------

function patchClaudeSettings(mutate) {
  const raw = fs.existsSync(CLAUDE_SETTINGS) ? fs.readFileSync(CLAUDE_SETTINGS, 'utf8') : '{}';
  const settings = JSON.parse(raw);
  mutate(settings);
  if (fs.existsSync(CLAUDE_SETTINGS)) fs.copyFileSync(CLAUDE_SETTINGS, `${CLAUDE_SETTINGS}.sessionboard-backup`);
  writeJSON(CLAUDE_SETTINGS, settings);
}

const pluginInstalled = (settings) => Object.keys(settings.enabledPlugins || {}).some((k) => k.startsWith('sessionboard@'));
const hookCommand = () => SELF.includes(`${path.sep}_npx${path.sep}`) ? 'npx -y sessionboard hook' : `node "${SELF}" hook`;
const hasOurHook = (settings) => JSON.stringify(settings.hooks?.SessionEnd || []).includes('sessionboard');

// ---------- dashboard ----------

function sessionView(s, index, rank) {
  return {
    id: s.id, rank, title: s.title || s.firstPrompt?.slice(0, 80) || '(untitled)', project: tildify(s.cwd), branch: s.branch, model: s.model,
    date: fmtDate(s.start), start: s.start, active: fmtMins(s.activeMinutes), activeMinutes: s.activeMinutes,
    judge: s.judge ? { score: s.judge.score, summary: s.judge.summary, reason: s.judge.reason } : null,
    heuristic: s.heuristic, eligible: s.eligible, missing: !!s.missing,
    pinned: index.pinned.includes(s.id), hidden: index.hidden.includes(s.id),
    stats: { toolCalls: s.toolCalls, files: s.filesChanged.length, tests: s.testRuns, commits: s.commits, prs: s.prs, prompts: s.prompts },
  };
}

function dashboard(flags) {
  const cfg = loadConfig();
  const page = fs.readFileSync(path.join(ROOT, 'lib', 'dashboard.html'), 'utf8');
  let judging = null;   // id currently being judged, so the UI can show progress

  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const findSession = (id) => readIndex().sessions[id];

  const server = http.createServer((req, res) => {
    // Only answer to our own origin: blocks DNS-rebinding and cross-site requests from other tabs.
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost'].includes(host)) return json(res, 403, { error: 'forbidden host' });
    if (req.method === 'POST' && req.headers['x-sessionboard'] !== '1') return json(res, 403, { error: 'missing header' });
    const url = new URL(req.url, 'http://localhost');
    const m = url.pathname.match(/^\/api\/sessions\/([\w-]+)(?:\/(\w+))?$/);
    try {
      if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(page); }

      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        const index = readIndex();
        const order = ranked(index);
        const rankOf = new Map(order.map((s, i) => [s.id, i + 1]));
        const all = Object.values(index.sessions).map((s) => sessionView(s, index, rankOf.get(s.id) || null));
        return json(res, 200, { topN: loadConfig().topN, updatedAt: index.updatedAt, judging, judgeEnabled: loadConfig().judge, sessions: all });
      }

      if (req.method === 'POST' && url.pathname === '/api/refresh') {
        scan();
        const cfg = loadConfig();
        if (cfg.judge && cfg.initialized && !judging) {
          // rate in a child so the server stays responsive; the UI polls `judging` to show progress
          judging = 'all';
          const child = spawn(process.execPath, [SELF, 'update', '--quiet'], { stdio: 'ignore', env: { ...process.env, [CHILD_ENV]: '1' } });
          child.on('exit', () => { judging = null; });
        }
        return json(res, 200, { ok: true });
      }

      if (m && req.method === 'GET' && m[2] === 'transcript') {
        const s = findSession(m[1]);
        if (!s) return json(res, 404, { error: 'not found' });
        if (s.missing) return json(res, 410, { error: 'Transcript was deleted by Claude Code cleanup.' });
        const emails = loadConfig().redactEmails;
        const turns = buildTranscript(s).map((t) => ({ role: t.role, parts: t.parts.map((p) => ({ ...p, text: redact(p.text, { emails }) })) }));
        return json(res, 200, { turns });
      }

      if (m && req.method === 'GET' && m[2] === 'export') {
        const s = findSession(m[1]);
        if (!s) return json(res, 404, { error: 'not found' });
        const html = url.searchParams.get('format') === 'html';
        const body = renderExport(s, { html, thinking: url.searchParams.has('thinking'), results: url.searchParams.has('results') });
        const name = `${exportSlug(s)}.${html ? 'html' : 'md'}`;
        res.writeHead(200, {
          'content-type': html ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8',
          ...(url.searchParams.has('download') ? { 'content-disposition': `attachment; filename="${name}"` } : {}),
        });
        return res.end(body);
      }

      if (m && req.method === 'POST' && ['pin', 'unpin', 'hide', 'unhide'].includes(m[2])) {
        setFlag(m[1], m[2]);
        return json(res, 200, { ok: true });
      }

      if (m && req.method === 'POST' && m[2] === 'rejudge') {
        if (judging) return json(res, 409, { error: 'already judging a session' });
        const s = findSession(m[1]);
        if (!s || s.missing) return json(res, 404, { error: 'not found' });
        judging = s.id;
        const child = spawn(process.execPath, [SELF, 'rejudge', s.id, '--quiet'], { stdio: 'ignore', env: { ...process.env, [CHILD_ENV]: '1' } });
        child.on('exit', () => { judging = null; });
        return json(res, 202, { ok: true });
      }

      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  });

  let port = Number(flags.port) || cfg.port;
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && port < cfg.port + 20) { port++; server.listen(port, '127.0.0.1'); }
    else { console.error(err.message); process.exit(1); }
  });
  server.on('listening', () => {
    const url = `http://localhost:${port}`;
    console.log(`sessionboard dashboard → ${url}  (Ctrl+C to stop)`);
    if (!flags['no-open']) spawn(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  });
  server.listen(port, '127.0.0.1');
}

function setFlag(id, action) {
  return withIndex((index) => {
    const s = index.sessions[id] || Object.values(index.sessions).find((x) => x.id.startsWith(id));
    if (!s) throw new Error('session not found');
    const key = action.endsWith('pin') ? 'pinned' : 'hidden';
    index[key] = index[key].filter((x) => x !== s.id);
    if (!action.startsWith('un')) index[key].push(s.id);
    return s;
  });
}

// ---------- init & interactive config ----------

const MODELS = [
  { label: 'Haiku', value: 'haiku', hint: 'fast, cheapest, good enough for ranking (recommended)' },
  { label: 'Sonnet', value: 'sonnet', hint: 'sharper judgement, ~3x the cost of Haiku' },
  { label: 'Opus', value: 'opus', hint: 'best judgement, slowest and most expensive' },
  { label: 'Off', value: false, hint: 'no AI: rank with the free heuristic only' },
];
const REJUDGE = [
  { label: 'When it grows 25%', value: 1.25, hint: 'resumed sessions get re-rated (recommended)' },
  { label: 'When it doubles', value: 2, hint: 'fewer re-rates' },
  { label: 'Never', value: 0, hint: 'first score is final' },
];
const BOARD = [3, 5, 10].map((n) => ({ label: `Top ${n}`, value: n }));
const GATES = [
  { label: 'Standard', value: [2, 5], hint: '≥2 prompts and ≥5 tool calls (recommended)' },
  { label: 'Strict', value: [5, 20], hint: '≥5 prompts and ≥20 tool calls: only big sessions' },
  { label: 'Everything', value: [1, 1], hint: 'rate every session, even one-liners' },
];
const modelName = (m) => MODELS.find((x) => x.value === m)?.label ?? m;
const rejudgeName = (g) => REJUDGE.find((x) => x.value === g)?.label ?? `when it grows ${Math.round((g - 1) * 100)}%`;

function howItWorks(cfg) {
  const judge = cfg.judge ? `${modelName(cfg.judgeModel)} scores it 0-10 + a summary and the why` : 'AI judge is off: free heuristic score';
  return box([
    '',
    `${accent('1')}  You close a Claude Code session`,
    `${dim('│')}  ${dim('a hook runs in the background, never slows you down')}`,
    `${dim('▼')}`,
    `${accent('2')}  Gate: was it real work?  ${dim(`≥${cfg.minPrompts} prompts, ≥${cfg.minToolCalls} tool calls`)}`,
    `${dim('│')}  ${dim('trivial sessions stop here, no AI call')}`,
    `${dim('▼')}`,
    `${accent('3')}  AI judge: ${judge}`,
    `${dim('│')}  ${dim('task difficulty · your direction · verified · shipped')}`,
    `${dim('▼')}`,
    `${accent('4')}  Board: your top ${cfg.topN}, always current`,
    `${dim('▼')}`,
    `${accent('5')}  Share: redacted HTML / Markdown, or the local dashboard`,
    '',
  ], { title: 'How it works' });
}

// Walks through every setting. Returns { cfg, retention, hook } without applying anything.
async function configure(flags, { firstRun }) {
  const cur = loadConfig();
  const settings = readJSON(CLAUDE_SETTINGS, {});
  const ask = (q, opts, def, fallback) => select(q, opts, { def, fallback: flags.yes ? def : fallback });
  const idx = (opts, v) => Math.max(0, opts.findIndex((o) => JSON.stringify(o.value) === JSON.stringify(v)));

  const model = await ask('Which model should judge your sessions?', MODELS, cur.judge ? idx(MODELS, cur.judgeModel) : 3);
  const rejudgeGrowth = model === false ? cur.rejudgeGrowth : await ask('When should a resumed session be re-rated?', REJUDGE, idx(REJUDGE, cur.rejudgeGrowth));
  const topN = await ask('How big is your board?', BOARD, idx(BOARD, cur.topN));
  const [minPrompts, minToolCalls] = await ask('Which sessions count?', GATES, idx(GATES, [cur.minPrompts, cur.minToolCalls]));
  const terms = await input('Words to hide in exports? (comma-separated, enter for none)', {
    initial: (cur.redactTerms || []).join(', '),
    hint: 'Company, product, client or internal host names you don\'t want in a shared transcript, e.g. acme, projectx, internal.acme.com',
  });
  const redactTerms = terms.split(',').map((x) => x.trim()).filter(Boolean);
  const redactEmails = await ask('Redact email addresses in exports?', [
    { label: 'Yes', value: true, hint: 'recommended' }, { label: 'No', value: false },
  ], cur.redactEmails ? 0 : 1);

  // Claude Code settings: never changed without an explicit answer (no terminal => leave alone).
  let retention = null;
  const days = settings.cleanupPeriodDays;
  if (!(days >= 365) && !flags['no-cleanup-change']) {
    console.log(`\n  ${yellow('!')} Claude Code deletes transcripts older than ${days || 30} days. Sessions past that`);
    console.log(`    drop off your board and can no longer be shared.`);
    retention = await ask('Keep transcripts longer? (edits ~/.claude/settings.json)', [
      { label: 'Keep for 10 years', value: KEEP_FOREVER_DAYS, hint: 'recommended' },
      { label: 'Keep for 1 year', value: 365 },
      { label: 'Leave as is', value: null, hint: `${days || 30} days` },
    ], 0, 2);
  }
  let hook = false;
  if (!pluginInstalled(settings) && !hasOurHook(settings)) {
    hook = await ask('Rate sessions automatically when they end? (adds a hook to ~/.claude/settings.json)', [
      { label: 'Yes', value: true, hint: 'recommended' },
      { label: 'No', value: false, hint: 'run `sessionboard update` yourself' },
    ], 0, 1);
  }

  const cfg = { judge: model !== false, judgeModel: model || cur.judgeModel, rejudgeGrowth, topN, minPrompts, minToolCalls, redactEmails, redactTerms };
  const hookState = pluginInstalled(settings) ? 'via plugin' : hasOurHook(settings) ? 'installed' : hook ? 'add hook' : 'off (manual updates)';
  const keepState = days >= 365 ? `${days} days` : retention ? `${retention} days ${dim(`(was ${days || 30})`)}` : `${days || 30} days ${dim('(unchanged)')}`;
  const row = (k, v) => `${padEnd(dim(k), 20)}${v}`;
  console.log(`\n${box([
    row('Judge model', cfg.judge ? modelName(cfg.judgeModel) : 'Off (heuristic only)'),
    row('Re-rate', cfg.judge ? rejudgeName(cfg.rejudgeGrowth) : dim('n/a')),
    row('Board size', `Top ${cfg.topN}`),
    row('Counts as real', `≥${cfg.minPrompts} prompts, ≥${cfg.minToolCalls} tool calls`),
    row('Redact emails', cfg.redactEmails ? 'Yes' : 'No'),
    row('Hidden words', cfg.redactTerms.length ? cfg.redactTerms.join(', ').slice(0, 34) : dim('none')),
    row('Keep transcripts', keepState),
    row('Auto-rate', hookState),
  ], { title: 'Your setup', width: 56 })}`);

  const ok = await select(firstRun ? 'Save and start rating?' : 'Save these settings?', [
    { label: 'Save', value: true }, { label: 'Cancel', value: false, hint: 'nothing is changed' },
  ], { def: 0, fallback: 0 });
  return ok ? { cfg, retention, hook } : null;
}

function applySetup({ cfg, retention, hook }) {
  saveConfig({ ...cfg, initialized: true });
  if (retention || hook) {
    patchClaudeSettings((st) => {
      if (retention) st.cleanupPeriodDays = retention;
      if (hook) {
        st.hooks ??= {};
        st.hooks.SessionEnd ??= [];
        st.hooks.SessionEnd.push({ hooks: [{ type: 'command', command: hookCommand(), timeout: 10 }] });
      }
    });
    console.log(`  ${green('✔')} Updated ${tildify(CLAUDE_SETTINGS)} ${dim(`(backup: ${path.basename(CLAUDE_SETTINGS)}.sessionboard-backup)`)}`);
  }
  console.log(`  ${green('✔')} Saved ${dim(tildify(CONFIG_FILE))}`);
}

async function rateWithProgress(sessions) {
  let n = 0;
  for (const s of sessions) {
    n++;
    const title = (s.title || s.firstPrompt || '(untitled)').slice(0, 46);
    const sp = spinner(`${dim(`${n}/${sessions.length}`)}  Rating ${title}…`);
    try {
      const v = await judgeAndStore(s.id, { force: true });
      sp.stop(`${green('✔')} ${dim(`${n}/${sessions.length}`)}  ${scoreBar(v.score)} ${bold(String(v.score).padStart(4))}  ${title}`);
    } catch (err) {
      sp.stop(`${red('✖')} ${dim(`${n}/${sessions.length}`)}  ${title}  ${dim(err.message.slice(0, 60))}`);
    }
  }
}

async function init(flags) {
  console.log(`\n  ${accent('▍')}${bold('sessionboard')}  ${dim('your best agent sessions, ranked and ready to share')}\n`);
  console.log(howItWorks(loadConfig()));
  console.log(`\n  ${dim('A few choices. Nothing is saved until you confirm at the end.')}`);

  const setup = await configure(flags, { firstRun: true });
  if (!setup) return console.log(`\n  Cancelled. Nothing was changed.\n`);
  applySetup(setup);

  const index = scan();
  const cfg = loadConfig();
  const eligible = Object.values(index.sessions).filter((s) => s.eligible && !s.missing);
  const pending = eligible.filter((s) => needsJudge(s, cfg)).sort((a, b) => b.heuristic - a.heuristic);
  const total = Object.keys(index.sessions).length;
  console.log(`\n  Found ${bold(total)} sessions on disk · ${bold(eligible.length)} count as real work · ${bold(pending.length)} need a score`);

  if (cfg.judge && pending.length) {
    let todo = pending;
    if (pending.length > 20) {
      todo = await select(`Rate how many now? (~${Math.round(8 * pending.length / 60)} min for all with ${modelName(cfg.judgeModel)})`, [
        { label: 'The 20 most promising', value: pending.slice(0, 20), hint: 'picked by the free heuristic (recommended)' },
        { label: `All ${pending.length}`, value: pending },
        { label: 'None for now', value: [], hint: 'new sessions still get rated as they end' },
      ], { def: 0, fallback: 0 });
    }
    if (todo.length) {
      console.log(`\n  ${bold('Rating')} ${dim(`with ${modelName(cfg.judgeModel)}, one call per session`)}\n`);
      await rateWithProgress(todo);
    }
  }

  console.log(`\n  ${bold(`Your top ${cfg.topN}`)}\n`);
  printTop(readIndex(), cfg.topN);
  console.log(`\n${box([
    `${accent('sessionboard dashboard')}     open the dashboard in your browser`,
    `${accent('sessionboard share 1 --html')} redacted page for your #1 session`,
    `${accent('sessionboard config')}        change any of these settings`,
  ], { title: 'Next', width: 60 })}\n`);
}

// ---------- CLI ----------

function resolveSession(index, ref = '1') {
  if (/^\d{1,3}$/.test(ref)) return ranked(index)[Number(ref) - 1];
  return Object.values(index.sessions).find((s) => s.id.startsWith(ref));
}

const wrap = (text, width, indent) => {
  const out = []; let line = '';
  for (const w of text.split(/\s+/)) {
    if (line && line.length + w.length + 1 > width) { out.push(line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out.map((l) => indent + l).join('\n');
};

// Terminal version of describe(): colors, score bar, wrapped text.
function describeTerm(s, i, index) {
  const width = Math.min(process.stdout.columns || 80, 100) - 8;
  const tags = [index.pinned.includes(s.id) && accent('pinned'), s.missing && red('transcript deleted')].filter(Boolean).join(dim(' · '));
  const score = s.judge ? `${scoreBar(s.judge.score)} ${bold(s.judge.score)}${dim('/10')}` : dim('not rated yet');
  const lines = [
    `  ${medal(i + 1)}  ${bold(s.title || s.firstPrompt?.slice(0, 60) || '(untitled)')}${tags ? `  ${tags}` : ''}`,
    `      ${score}   ${dim(`${fmtDate(s.start)} · ${tildify(s.cwd) || '?'} · ${shortId(s.id)}`)}`,
  ];
  if (s.judge?.summary) lines.push(wrap(s.judge.summary, width, '      '));
  if (s.judge?.reason) lines.push(dim(wrap(`why: ${s.judge.reason}`, width, '      ')));
  lines.push(dim(wrap(highlights(s), width, '      ')));
  return lines.join('\n');
}

function printTop(index, n) {
  const list = ranked(index).slice(0, n);
  if (!list.length) return console.log('  No eligible sessions yet. Do some real work with Claude Code first.');
  console.log(list.map((s, i) => describeTerm(s, i, index)).join('\n\n'));
}

function parseArgs(argv) {
  const flags = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) flags[k] = v;
    else if (['out', 'n', 'port'].includes(k)) flags[k] = argv[++i];
    else flags[k] = true;
  }
  return { flags, pos };
}

const HELP = `sessionboard - an AI-judged leaderboard of your Claude Code sessions

  sessionboard init                       one-time setup (asks before changing any settings)
  sessionboard dashboard [--port N]       open the local dashboard (http://localhost:4317)
  sessionboard top [--n 5]                print your top sessions
  sessionboard share [rank|id] [opts]     export a redacted, shareable transcript
        --html          self-contained HTML instead of Markdown
        --out <file>    output path (default ~/.sessionboard/exports/)
        --copy          copy to clipboard
        --gist          upload as a SECRET GitHub gist (needs gh) and print the URL
        --thinking      include the agent's thinking blocks
        --results       include truncated tool output
        --keep-emails   don't redact email addresses
  sessionboard update                     rescan and rate any new sessions
  sessionboard rejudge <rank|id>          rate one session again
  sessionboard pin|unpin|hide|unhide <id> curate the board by hand
  sessionboard show <rank|id>             all stats for one session
  sessionboard config                     change settings interactively (or: config key=value)

Data lives in ${tildify(DATA_DIR)}; TOP3.md there is always current.`;

async function main() {
  const [cmd = 'top', ...rest] = process.argv.slice(2);
  const { flags, pos } = parseArgs(rest);
  const log = flags.quiet ? () => {} : (m) => process.stderr.write(m);

  if (cmd === 'hook') {
    // SessionEnd hook: return immediately, rate the session that just ended in a detached child.
    if (process.env[CHILD_ENV]) return;
    let input = {};
    try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch {}
    const id = input.session_id || (input.transcript_path && path.basename(input.transcript_path, '.jsonl'));
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const out = fs.openSync(path.join(DATA_DIR, 'hook.log'), 'a');
    spawn(process.execPath, [SELF, 'rate-one', id || '', '--quiet'], { detached: true, stdio: ['ignore', out, out], env: { ...process.env, [CHILD_ENV]: '1' } }).unref();
    return;
  }

  if (cmd === 'help' || flags.help || flags.h) return console.log(HELP);
  if (cmd === 'init') return init(flags);
  if (cmd === 'dashboard' || cmd === 'ui') { scan(); return dashboard(flags); }

  if (cmd === 'config') {
    if (!pos.length && process.stdin.isTTY && !flags.json) {
      console.log(`\n  ${accent('▍')}${bold('sessionboard')} ${dim('settings')}`);
      const setup = await configure(flags, { firstRun: false });
      if (!setup) return console.log('\n  Cancelled. Nothing was changed.\n');
      applySetup(setup);
      scan();   // re-apply thresholds to the board
      return console.log(`  ${dim('New sessions use these settings. Run `sessionboard update` to rate anything now unrated.')}\n`);
    }
    const cur = readJSON(CONFIG_FILE, {});
    for (const kv of pos) {
      const [k, v] = kv.split('=');
      if (!(k in DEFAULT_CONFIG)) { console.error(`unknown key: ${k}`); process.exit(1); }
      const d = DEFAULT_CONFIG[k];
      cur[k] = typeof d === 'boolean' ? v === 'true' : typeof d === 'number' ? Number(v) : Array.isArray(d) ? (v || '').split(',').map((x) => x.trim()).filter(Boolean) : v;
    }
    if (pos.length) { writeJSON(CONFIG_FILE, cur); scan(); }
    return console.log(JSON.stringify({ ...DEFAULT_CONFIG, ...cur }, null, 2));
  }

  const cfg = loadConfig();
  const index = scan();
  const canJudge = cfg.judge && cfg.initialized;   // never spawn `claude` before init has asked about cleanup

  if (cmd === 'rate-one') {
    if (!canJudge) return;
    const id = pos[0] && index.sessions[pos[0]] ? pos[0] : null;
    try { if (id) await judgeAndStore(id, { log }); } catch (err) { console.error(`${new Date().toISOString()} ${pos[0]}: ${err.message}`); }
    return;
  }

  if (cmd === 'update') {
    if (canJudge) await judgePending({ log });
    else if (!cfg.initialized) log('Not initialized yet; run `sessionboard init` to enable AI rating.\n');
    if (!flags.quiet) console.log(`Updated. ${Object.keys(readIndex().sessions).length} sessions indexed → ${tildify(TOP_FILE)}`);
    return;
  }

  if (cmd === 'top' || cmd === 'ls') {
    if (!cfg.initialized) console.log(`\n  ${yellow('!')} AI rating is off until you run ${accent('sessionboard init')}`);
    console.log(`\n  ${bold(`Your top ${Number(flags.n) || cfg.topN} agent sessions`)}\n`);
    printTop(readIndex(), Number(flags.n) || cfg.topN);
    console.log(`\n  ${dim('share one:')} ${accent('sessionboard share 1 --html')}   ${dim('dashboard:')} ${accent('sessionboard dashboard')}\n`);
    return;
  }

  const s = resolveSession(index, pos[0]);
  if (['share', 'export', 'show', 'rejudge', 'pin', 'unpin', 'hide', 'unhide'].includes(cmd) && !s) {
    console.error(`No session "${pos[0] || 1}". Run \`sessionboard top\` to see ranks.`);
    process.exit(1);
  }

  if (cmd === 'rejudge') {
    if (!cfg.initialized) { console.error('Run `sessionboard init` first.'); process.exit(1); }
    try { await judgeAndStore(s.id, { force: true, log }); } catch (err) { console.error(`failed: ${err.message}`); process.exit(1); }
    return;
  }

  if (['pin', 'unpin', 'hide', 'unhide'].includes(cmd)) {
    setFlag(s.id, cmd);
    return console.log(`${cmd}: ${shortId(s.id)} "${s.title || ''}"`);
  }

  if (cmd === 'show') {
    const { file, ...rest } = s;
    return console.log(JSON.stringify({ ...rest, file: tildify(file) }, null, 2));
  }

  if (cmd === 'share' || cmd === 'export') {
    const html = !!flags.html;
    let content;
    try { content = renderExport(s, { html, thinking: !!flags.thinking, results: !!flags.results, keepEmails: !!flags['keep-emails'] }); }
    catch (err) { console.error(err.message); process.exit(1); }
    const out = flags.out ? path.resolve(flags.out) : path.join(EXPORT_DIR, `${exportSlug(s)}.${html ? 'html' : 'md'}`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, content);
    console.log(`Exported "${s.title || s.id}" → ${out}`);
    console.log(`Redacted: home paths, API keys/tokens/secrets${cfg.redactEmails && !flags['keep-emails'] ? ', emails' : ''}. Skim it before sharing.`);
    if (flags.copy) {
      const [bin, args] = process.platform === 'darwin' ? ['pbcopy', []] : process.platform === 'win32' ? ['clip', []] : ['xclip', ['-selection', 'clipboard']];
      console.log(spawnSync(bin, args, { input: content }).status === 0 ? 'Copied to clipboard.' : `Could not copy (${bin} unavailable).`);
    }
    if (flags.gist) {
      const r = spawnSync('gh', ['gist', 'create', out, '--desc', `Agent session: ${s.title || ''}`], { encoding: 'utf8' });
      console.log(r.status === 0 ? `Secret gist: ${r.stdout.trim()}` : `gist failed: ${(r.stderr || '').trim()}`);
    }
    return;
  }

  console.log(HELP);
}

main().catch((err) => { console.error(err.message); process.exit(1); });

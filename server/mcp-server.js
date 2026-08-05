#!/usr/bin/env node
'use strict';
/*
 * MCP adapter over the bridge server's HTTP API. Zero dependencies, stdio transport.
 *
 * Why an adapter and not MCP inside transcript-server.js: the extension needs plain HTTP and always
 * will, and a hosted deployment needs the same tools over a network transport. Keeping MCP as a thin
 * client of the HTTP API means one data plane with two front doors, and this file stays testable by
 * piping JSON-RPC at it.
 *
 * What this replaces: the assistant used to shell out to `curl` four or five times a turn and keep a
 * byte offset into `<session>.wake` in a shell variable. `poll` does all of that in one call with the
 * offset held server-side, which also makes it work with no filesystem in reach.
 *
 * What it deliberately does NOT do: wake the assistant. MCP is client-pull; nothing here can start a
 * turn. The wake loop stays on the client (see the skill), and it is the one thing that must poll.
 *
 *   MLA_URL     bridge server base URL (default http://127.0.0.1:8848)
 *   MLA_TOKEN   auth token; falls back to <TRANSCRIPTS_DIR>/.mla-token
 *   MLA_AGENT   name this assistant claims a meeting under (default: the working directory's name)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');

const VERSION = '0.4.0';
const BASE = (process.env.MLA_URL || 'http://127.0.0.1:8848').replace(/\/$/, '');
// The name this assistant claims a meeting under. It has to be BOTH stable across a restart of this
// process (or an assistant cannot recognise a claim it made itself, and talks itself out of its own
// meeting) AND distinct between assistants (or two of them look like one and both attach). The client's
// working directory is both: each agent runs in its own project, and that does not change when it
// reconnects. MLA_AGENT overrides it, and should, when a name would be nicer in the panel's pill.
function defaultAgentName() {
  try {
    const cwd = process.cwd();
    const base = path.basename(cwd);
    // The bare basename is not distinct enough: two checkouts both called `frontend`, or two clients started
    // from `$HOME`, produce the same name - and two assistants sharing a name share a read position, so
    // captions go to whichever polls first. The path suffix makes it distinct while keeping it stable
    // across a reconnect, which is the other half of the requirement.
    const tag = crypto.createHash('sha1').update(cwd).digest('hex').slice(0, 4);
    if (base && base !== '/' && base !== '.') return `${base}-${tag}`;
  } catch (_) {}
  return 'assistant';
}
const AGENT = process.env.MLA_AGENT || defaultAgentName();
// A second reader identity for tool calls, so they never consume what the wake loop has not read yet.
const TOOL_CONSUMER = `${AGENT}.tool`;

function defaultTranscriptsDir() {
  const beside = path.resolve(__dirname, '..', 'transcripts');
  try { if (fs.existsSync(beside)) return beside; } catch (_) {}
  return path.join(os.homedir(), 'meet-live-assist', 'transcripts');
}
let TRANSCRIPTS_DIR = process.env.TRANSCRIPTS_DIR ? path.resolve(process.env.TRANSCRIPTS_DIR) : defaultTranscriptsDir();

// The running server knows where its data is; guessing does not. On this machine the guess is actively
// wrong - a `transcripts/` dir sits beside the checkout while the service writes somewhere else entirely,
// so every call would 403 on a token read from the wrong directory. /health needs no token, so ask.
// Only meaningful for a local server, which is exactly the case that has a filesystem in common with us.
let located = false;
let locating = null;
// Retrying is what makes this correct: the server normally starts after we do, so the first probe fails and
// the answer arrives later. No cooldown between attempts - a cooldown means that for its duration every
// call reports a bad token about a server that has just come up - but the probe is short, and while the
// server is down the call was going to fail anyway.
async function locateDataDir() {
  if (located || process.env.TRANSCRIPTS_DIR || process.env.MLA_TOKEN) return;
  if (locating) return locating; // concurrent calls share one probe rather than each making their own
  locating = attemptLocate().finally(() => { locating = null; });
  return locating;
}
async function attemptLocate() {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return;
    const { dir } = await r.json();
    if (dir && fs.existsSync(path.join(dir, '.mla-token'))) {
      TRANSCRIPTS_DIR = dir;
      // Latch only on success. This adapter is started with the client's session, normally BEFORE the
      // bridge server, so the first attempt usually fails - latching then would pin the guessed directory
      // for the whole session and every call would report "token rejected" while pointing at a path where
      // no token has ever been.
      located = true;
    }
  } catch (_) { /* server down: the error the caller gets says so, which is more useful than this */ }
}

function readToken() {
  if (process.env.MLA_TOKEN) return process.env.MLA_TOKEN.trim();
  try { return fs.readFileSync(path.join(TRANSCRIPTS_DIR, '.mla-token'), 'utf8').trim(); } catch (_) { return ''; }
}
// Re-read per request rather than caching: the token is minted by the server on its first boot, which
// may happen after this adapter started, and a stale empty token would 403 every call for the session.
function headers() {
  const h = { 'Content-Type': 'application/json' };
  const t = readToken();
  if (t) h['X-MLA-Token'] = t;
  return h;
}

// The wake loop: a POSIX shell script the assistant runs under a persistent Monitor. It is the only thing
// that can start an assistant's turn, so every one of its failure modes costs the rest of a meeting, and
// all of them are silent by nature. Four reviews have now found bugs in these twelve lines; the notes are
// what each of them cost.
//
//   - The HTTP status comes from `-w %{http_code}` appended to the body, and is split off with POSIX
//     parameter expansion (it is always exactly three characters). `--fail-with-body` would be tidier but
//     landed in curl 7.76: on Debian 11, Ubuntu 20.04, RHEL 8 or macOS 11 it makes curl exit 2, which read
//     as "server unreachable" while the server was fine, and printed an unknown-option line every two
//     seconds forever.
//   - Splitting this way also PRESERVES the batch's trailing newline. `$(...)` strips trailing newlines, so
//     printing the body alone glued the last line of each batch to the first line of the next.
//   - The cadence resets on any successful request, not on a non-empty one. Resetting only on content meant
//     that after a blip the loop stayed at 30s for the rest of a quiet meeting, so the next real event -
//     Stop included, which has no other route - arrived up to 30s late, and a second failure was never
//     reported because the "say it once" guard stayed latched.
//   - The token is re-read every iteration. It is minted by the server on its first boot, which routinely
//     happens after this loop was armed.
function shQuote(v) { return `'${String(v).replace(/'/g, `'\\''`)}'`; }

function wakeLoopFor(url) {
  const tokenFile = path.join(TRANSCRIPTS_DIR, '.mla-token');
  // The loop runs in a shell the assistant spawns, which does not inherit this process's environment, so
  // `$MLA_TOKEN` is empty there. Read the file when it holds the token we are actually using; otherwise
  // there is nothing to read and the value has to travel in the script itself.
  let fileToken = '';
  try { fileToken = fs.readFileSync(tokenFile, 'utf8').trim(); } catch (_) {}
  const envToken = (process.env.MLA_TOKEN || '').trim();
  const readToken = (fileToken && (!envToken || fileToken === envToken))
    ? `T=$(cat ${shQuote(tokenFile)})`
    : `T=${shQuote(envToken)}`;
  return [
    // W is the cadence, E latches the reporting. Keeping them separate matters: tying "say it once" to the
    // cadence meant a second failure was never reported, and a 30s cadence after an outage meant the server
    // coming back went unnoticed for half a minute. An unreachable local server is a cheap, instant
    // ECONNREFUSED, and launchd restarts it in seconds, so retrying at 5s costs nothing and recovers fast.
    // A rejected token needs a human, so that one waits.
    'W=2; E=0',
    'while true; do',
    `  ${readToken}`,
    `  R=$(curl -s --max-time 10 -w '%{http_code}' -H "X-MLA-Token: $T" ${shQuote(url)}); RC=$?`,
    '  C=${R#"${R%???}"}; B=${R%???}',
    '  if [ "$RC" != 0 ]; then',
    '    [ "$E" = 0 ] && echo "mla: cannot reach the bridge server - you are blind until it is back"',
    '    E=1; W=5',
    '  elif [ "$C" = 200 ]; then',
    '    [ "$E" = 1 ] && echo "mla: the bridge server is back"',
    '    E=0; W=2; [ -n "$B" ] && printf %s "$B"',
    '  elif [ "$C" = 403 ]; then',
    '    [ "$E" = 0 ] && echo "mla: the server rejected the token - re-check it in the extension options"',
    '    E=1; W=30',
    '  else',
    '    [ "$E" = 0 ] && echo "mla: the bridge server answered $C - the wake channel is not working"',
    '    E=1; W=30',
    '  fi',
    '  sleep "$W"',
    'done',
  ].join('\n');
}

// The pinned meeting. Held here, not passed by the caller every time: an assistant that re-resolves the
// session each turn eventually follows the user into their *next* call and starts assisting a meeting
// nobody asked it to join. `attach` sets this once.
let pinned = '';

class ToolError extends Error {}

// One tool call at a time. Clients send several in a single turn, and `pinned` is only set after `attach`
// has made three round trips - so an `advice` issued alongside an `attach` read the *previous* meeting and
// posted into it. Reproduced: the advice for meeting B landed in meeting A.
let queue = Promise.resolve();
function serialise(fn) {
  const run = queue.then(fn);
  queue = run.then(() => {}, () => {});
  return run;
}

async function api(method, route, body) {
  await locateDataDir();
  let res;
  try {
    res = await fetch(`${BASE}${route}`, {
      method,
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      // Without a deadline a hung server keeps a request in flight forever, and the drain-before-exit below
      // then never lets the process go: one leaked adapter per client shutdown mid-call.
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new ToolError(`the bridge server is not reachable at ${BASE} (${e.message}). Start it: npx meet-live-assist-server`);
  }
  const text = await res.text();
  if (res.status === 403) throw new ToolError(`the bridge server rejected the token. Check MLA_TOKEN or ${path.join(TRANSCRIPTS_DIR, '.mla-token')}`);
  if (!res.ok) throw new ToolError(`${method} ${route} failed: ${res.status} ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch (_) { return { text }; }
}

function sessionOf(args) {
  const s = (args && typeof args.session === 'string' && args.session.trim()) ? args.session.trim() : pinned;
  if (!s) throw new ToolError('no meeting attached yet - call `attach` first');
  return s;
}

// --- tools -----------------------------------------------------------------------------------------
// Descriptions are terse on purpose: every schema here is loaded into the caller's context on every
// turn of their session, so prose in this file is a permanent tax on someone else's budget.

const TOOLS = [
  {
    name: 'attach',
    description: 'Pin the meeting to assist and report its state. Call once at the start. Refuses if another assistant is already live on it unless force is set.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Meeting id. Omit to take the most recently active one.' },
        force: { type: 'boolean', description: 'Attach even if another assistant is live.' },
      },
    },
    async run(args) {
      const want = (args.session || '').trim();
      const info = await api('GET', `/sessions${want ? `?session=${encodeURIComponent(want)}` : ''}`);
      if (!info.session) throw new ToolError('no meeting has produced any transcript yet - is the extension capturing?');
      // "Another assistant" means a DIFFERENT one. The heartbeat this reads is bumped by our own `working`
      // calls, so without comparing the claim name, an adapter restarted mid-call (the client reconnecting
      // is routine) saw its own liveness and refused the meeting it was already assisting - and the skill's
      // documented response to a refusal is to stop and tell the user.
      const mine = !info.assistant || info.assistant === AGENT;
      if (!mine && info.assistantAgeMs != null && info.assistantAgeMs < 45000 && !args.force) {
        throw new ToolError(`${info.assistant} is already live on ${info.session} (last seen ${Math.round(info.assistantAgeMs / 1000)}s ago). One assistant per meeting: stop, or pass force:true.`);
      }
      pinned = info.session;
      await api('POST', '/brain-takeover', { session: pinned, agent: AGENT });
      const status = await api('GET', `/poll?session=${encodeURIComponent(pinned)}&consumer=${encodeURIComponent(AGENT)}&statusOnly=1`);
      // Hand back the wake loop ready to run, rather than leaving its URL to be composed by hand: getting
      // the session or the consumer wrong looks exactly like a broken server for the rest of the call.
      //
      // The loop and the `poll` tool use DIFFERENT consumers on purpose. Reading a consumer's cursor is
      // destructive, so sharing one meant a mid-turn `poll` could swallow the state change the loop was
      // about to wake on - including Stop, which is the one signal that has no other route. Separate
      // cursors cost nothing because a fresh consumer starts at the end of the channel, not at zero.
      // Seed the loop's position at the start of the meeting HERE, rather than leaving `backlog=1` in the
      // loop's URL for the rest of the call. With it in the URL, a position lost to eviction was recreated
      // at zero and the loop replayed the whole meeting as if it had just been said.
      await api('GET', `/poll?session=${encodeURIComponent(pinned)}&consumer=${encodeURIComponent(AGENT)}&backlog=1&seed=1`);
      const wakeUrl = `${BASE}/poll?session=${encodeURIComponent(pinned)}&consumer=${encodeURIComponent(AGENT)}&format=text`;
      return {
        session: pinned, lines: info.lines, date: info.date, startedAt: info.startedAt, status: status.status,
        wakeLoop: wakeLoopFor(wakeUrl),
      };
    },
  },
  {
    name: 'poll',
    description: 'Everything new since your last poll: transcript batch worth a turn, panel state (paused/mode/autopilot/suppressed topics), and any pending results. One call per turn; the offset is tracked server-side.',
    inputSchema: { type: 'object', properties: { session: { type: 'string' } } },
    async run(args) {
      const s = sessionOf(args);
      return api('GET', `/poll?session=${encodeURIComponent(s)}&consumer=${encodeURIComponent(TOOL_CONSUMER)}`);
    },
  },
  {
    name: 'transcript',
    description: 'Read the complete meeting record, not just the batches worth a turn. Use for wrap-up or to reconcile something you missed.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        tail_lines: { type: 'integer', description: 'Last N lines (default 200, max 2000).' },
      },
    },
    async run(args) {
      const s = sessionOf(args);
      const n = Math.min(Math.max(parseInt(args.tail_lines || 200, 10) || 200, 1), 2000);
      return api('GET', `/transcript?session=${encodeURIComponent(s)}&tail=${n}`);
    },
  },
  {
    name: 'advice',
    description: 'Show a line in the side panel. SAY = words to say now, RISK = a problem, INFO = context, EXPLAIN = a term, ACTION = do this, SUMMARY = recap. Keep it one glanceable sentence.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        marker: { type: 'string', enum: ['SAY', 'INFO', 'SUMMARY', 'EXPLAIN', 'RISK', 'ACTION'] },
        session: { type: 'string' },
      },
      required: ['text'],
    },
    run(args) {
      return api('POST', '/advice', { session: sessionOf(args), text: args.text, marker: args.marker || 'INFO' });
    },
  },
  {
    name: 'item',
    description: 'Add to the decisions and action-items board. Only for things actually decided or assigned, not for topics discussed.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        kind: { type: 'string', enum: ['decision', 'action', 'blocker'] },
        owner: { type: 'string' },
        blocked_by: { type: 'string' },
        session: { type: 'string' },
      },
      required: ['text'],
    },
    run(args) {
      return api('POST', '/items', {
        session: sessionOf(args), text: args.text, kind: args.kind || 'action',
        owner: args.owner || '', blockedBy: args.blocked_by || '',
      });
    },
  },
  {
    name: 'chat_reply',
    description: 'Reply in the side panel chat, where the user types to you privately. Not the meeting chat - that is call_chat.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, session: { type: 'string' } }, required: ['text'] },
    run(args) {
      return api('POST', '/chat', { session: sessionOf(args), role: 'agent', text: args.text });
    },
  },
  {
    name: 'working',
    description: 'Heartbeat, so the panel shows you are alive. Pass status to show what you are doing ("checking Jira"); pass an empty status when done. Call every turn.',
    inputSchema: { type: 'object', properties: { status: { type: 'string' }, session: { type: 'string' } } },
    run(args) {
      const body = { session: sessionOf(args) };
      if (args.status !== undefined) body.status = args.status;
      return api('POST', '/brain-ping', body);
    },
  },
  {
    name: 'summary',
    description: 'Save the post-call wrap-up as markdown. The panel offers it for copy and download.',
    inputSchema: { type: 'object', properties: { markdown: { type: 'string' }, session: { type: 'string' } }, required: ['markdown'] },
    run(args) {
      return api('POST', '/summary', { session: sessionOf(args), text: args.markdown });
    },
  },
  {
    name: 'snapshot_request',
    description: 'Ask the extension to capture the shared screen. Returns immediately; read the image with snapshot_read on a later turn.',
    inputSchema: { type: 'object', properties: { session: { type: 'string' } } },
    run(args) {
      return api('POST', '/snapshot-request', { session: sessionOf(args) });
    },
  },
  {
    name: 'snapshot_read',
    description: 'List captured screen snapshots for this meeting, newest first, with their paths.',
    inputSchema: { type: 'object', properties: { session: { type: 'string' }, limit: { type: 'integer' } } },
    async run(args) {
      const s = sessionOf(args);
      const n = Math.min(Math.max(parseInt(args.limit || 5, 10) || 5, 1), 40);
      return api('GET', `/snapshots?session=${encodeURIComponent(s)}&limit=${n}`);
    },
  },
  {
    name: 'call_chat',
    description: 'Send a message into the meeting chat, visible to everyone. Returns the delivery result; poll reports failures too.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, session: { type: 'string' } }, required: ['text'] },
    run(args) {
      return api('POST', '/callchat', { session: sessionOf(args), text: args.text });
    },
  },
  {
    name: 'speak',
    description: 'Say something out loud into the call. Local macOS installs only; fails with an explanation elsewhere.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, voice: { type: 'string' }, device: { type: 'string' }, session: { type: 'string' } },
      required: ['text'],
    },
    run(args) {
      return api('POST', '/speak', { session: sessionOf(args), text: args.text, voice: args.voice, device: args.device });
    },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// --- JSON-RPC over stdio ---------------------------------------------------------------------------

function send(msg) { process.stdout.write(`${JSON.stringify(msg)}\n`); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  // `null`, a bare string or an array all parse as JSON but are not requests. Destructuring them threw, and
  // the catch below then threw again reading `msg.id`, taking the process down with an unhandled rejection
  // and leaving every later request unanswered.
  if (Array.isArray(msg)) {
    // Batching was dropped after protocol version 2025-03-26. Answering with an error beats the previous
    // behaviour, which was to silently discard it and leave the client waiting forever.
    return send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batched requests are not supported' } });
  }
  if (!msg || typeof msg !== 'object') {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } });
  }
  const { id, method, params } = msg;
  // A notification carries no id and must never be answered, not even on error.
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    // Echo the client's protocol version: this adapter has no version-specific behaviour, so accepting
    // whatever the client speaks is strictly more compatible than pinning a version it may not know.
    const pv = (params && typeof params.protocolVersion === 'string') ? params.protocolVersion : '2025-06-18';
    return reply(id, {
      protocolVersion: pv,
      capabilities: { tools: {} },
      serverInfo: { name: 'meet-live-assist', version: VERSION },
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') {
    return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  }
  if (method === 'tools/call') {
    const tool = BY_NAME.get(params && params.name);
    if (!tool) return fail(id, -32602, `unknown tool: ${params && params.name}`);
    try {
      const out = await serialise(() => tool.run((params && params.arguments) || {}));
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(out) }] });
    } catch (e) {
      // A tool failure is a result, not a protocol error: the model has to see it and react, and an
      // error response would make the client surface it as a broken server instead.
      const detail = e instanceof ToolError ? e.message : `unexpected failure: ${e && e.message}`;
      return reply(id, { content: [{ type: 'text', text: detail }], isError: true });
    }
  }
  if (isNotification) return;
  return fail(id, -32601, `method not found: ${method}`);
}

// Requests in flight when stdin closes. Exiting on close alone drops any tool call still waiting on the
// bridge server, and every tool call waits on it: a client that closes stdin as it shuts down would get
// silence instead of the result it asked for. It also made this file untestable by piping JSON at it,
// which is how the bug surfaced.
let inFlight = 0;
let stdinClosed = false;
function maybeExit() { if (stdinClosed && inFlight === 0) process.exit(0); }

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch (_) { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
  inFlight++;
  Promise.resolve(handle(msg))
    .catch((e) => { const id = msg && msg.id; if (id !== undefined && id !== null) fail(id, -32603, `internal error: ${e && e.message}`); })
    .finally(() => { inFlight--; maybeExit(); });
});
rl.on('close', () => { stdinClosed = true; maybeExit(); });

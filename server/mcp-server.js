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
 *   MLA_AGENT   name this assistant claims in `takeover` (default "assistant")
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const VERSION = '0.4.0';
const BASE = (process.env.MLA_URL || 'http://127.0.0.1:8848').replace(/\/$/, '');
const AGENT = process.env.MLA_AGENT || 'assistant';

function defaultTranscriptsDir() {
  const beside = path.resolve(__dirname, '..', 'transcripts');
  try { if (fs.existsSync(beside)) return beside; } catch (_) {}
  return path.join(os.homedir(), 'meet-live-assist', 'transcripts');
}
const TRANSCRIPTS_DIR = process.env.TRANSCRIPTS_DIR ? path.resolve(process.env.TRANSCRIPTS_DIR) : defaultTranscriptsDir();

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

// The pinned meeting. Held here, not passed by the caller every time: an assistant that re-resolves the
// session each turn eventually follows the user into their *next* call and starts assisting a meeting
// nobody asked it to join. `attach` sets this once.
let pinned = '';

class ToolError extends Error {}

async function api(method, route, body) {
  let res;
  try {
    res = await fetch(`${BASE}${route}`, {
      method,
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
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
      if (info.otherAssistantAgeMs != null && info.otherAssistantAgeMs < 45000 && !args.force) {
        throw new ToolError(`another assistant is live on ${info.session} (last seen ${Math.round(info.otherAssistantAgeMs / 1000)}s ago). One assistant per meeting: stop, or pass force:true.`);
      }
      pinned = info.session;
      await api('POST', '/brain-takeover', { session: pinned, agent: AGENT });
      const status = await api('GET', `/poll?session=${encodeURIComponent(pinned)}&consumer=${encodeURIComponent(AGENT)}&statusOnly=1`);
      // Hand back the wake loop ready to run. The read offset is per consumer, so the loop and this
      // adapter must poll under the SAME consumer or the two would each replay the whole meeting to the
      // other's blind spot. Composing that URL by hand is exactly the kind of detail that goes wrong
      // once and then looks like a broken server for the rest of the call.
      const wakeUrl = `${BASE}/poll?session=${encodeURIComponent(pinned)}&consumer=${encodeURIComponent(AGENT)}&format=text`;
      return {
        session: pinned, lines: info.lines, startedAt: info.startedAt, status: status.status,
        wakeLoop: `T=$(cat ${path.join(TRANSCRIPTS_DIR, '.mla-token')}); while true; do curl -s -H "X-MLA-Token: $T" "${wakeUrl}"; sleep 2; done`,
      };
    },
  },
  {
    name: 'poll',
    description: 'Everything new since your last poll: transcript batch worth a turn, panel state (paused/mode/autopilot/suppressed topics), and any pending results. One call per turn; the offset is tracked server-side.',
    inputSchema: { type: 'object', properties: { session: { type: 'string' } } },
    async run(args) {
      const s = sessionOf(args);
      return api('GET', `/poll?session=${encodeURIComponent(s)}&consumer=${encodeURIComponent(AGENT)}`);
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
      const out = await tool.run((params && params.arguments) || {});
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

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch (_) { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
  Promise.resolve(handle(msg)).catch((e) => {
    if (msg.id !== undefined && msg.id !== null) fail(msg.id, -32603, `internal error: ${e && e.message}`);
  });
});
rl.on('close', () => process.exit(0));

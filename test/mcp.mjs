// Contract test for the MCP adapter: boot the bridge server on a throwaway port, speak JSON-RPC at
// server/mcp-server.js over stdio, and assert the tools an assistant depends on.
//
//   node test/mcp.mjs
//
// The point of testing at this level is that it needs no browser and no meeting: everything the
// assistant does to a call is an HTTP effect, so a fake transcript pushed through /append is
// indistinguishable from a real one.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import readline from 'node:readline';

const ROOT = path.resolve(import.meta.dirname, '..');
const dir = mkdtempSync(path.join(tmpdir(), 'mla-mcp-'));
let failures = 0;
let bridge;
let mcp;

function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok || !detail ? '' : ` - ${detail}`}`);
  if (!ok) failures++;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- a minimal MCP client --------------------------------------------------------------------------
function client(proc) {
  const pending = new Map();
  const notes = [];
  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch (_) { notes.push(`unparseable: ${line}`); return; }
    if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
      pending.get(msg.id)(msg); pending.delete(msg.id);
    } else notes.push(line);
  });
  let nextId = 1;
  return {
    notes,
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
        pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
        proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method, params) { proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); },
  };
}

// tools/call returns its payload as JSON inside a text block, so unwrap it once here.
async function call(rpc, name, args = {}) {
  const res = await rpc.request('tools/call', { name, arguments: args });
  const text = res.result?.content?.[0]?.text ?? '';
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
  return { isError: !!res.result?.isError, text, data, error: res.error };
}

try {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  // WAKE_MIN_GAP_MS is 8s in production so the assistant is never woken twice in a row; the checks below
  // wake several times on purpose, so shorten it. Everything else about the gate is left at its default,
  // because the gate's judgement is exactly what is under test.
  bridge = spawn(process.execPath, [path.join(ROOT, 'server', 'transcript-server.js')], {
    env: { ...process.env, PORT: String(port), TRANSCRIPTS_DIR: dir, STATE_SNAPSHOT_MS: '150', WAKE_MIN_GAP_MS: '100' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bridgeErr = '';
  bridge.stderr.on('data', (c) => { bridgeErr += c; });
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    try { ready = (await fetch(`${base}/health`)).ok; } catch (_) { await sleep(250); }
  }
  if (!ready) throw new Error(`bridge never came up on ${port}\n${bridgeErr}`);
  const token = readFileSync(path.join(dir, '.mla-token'), 'utf8').trim();
  const auth = { 'Content-Type': 'application/json', 'X-MLA-Token': token };

  mcp = spawn(process.execPath, [path.join(ROOT, 'server', 'mcp-server.js')], {
    env: { ...process.env, MLA_URL: base, MLA_TOKEN: token, TRANSCRIPTS_DIR: dir, MLA_AGENT: 'test-agent' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let mcpErr = '';
  mcp.stderr.on('data', (c) => { mcpErr += c; });
  const rpc = client(mcp);

  // --- handshake ---
  const init = await rpc.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
  check('initialize is answered', !!init.result, JSON.stringify(init.error));
  check('initialize echoes the protocol version', init.result?.protocolVersion === '2025-06-18', init.result?.protocolVersion);
  check('the server declares the tools capability', !!init.result?.capabilities?.tools);
  rpc.notify('notifications/initialized');

  const listed = await rpc.request('tools/list');
  const tools = listed.result?.tools || [];
  check('tools/list returns tools', tools.length > 0, `${tools.length}`);
  check('every tool has a description and a schema', tools.every((t) => t.description && t.inputSchema?.type === 'object'));
  // The tool surface is loaded into the caller's context every turn, so its size is a product decision,
  // not an accident. If this fails, the fix is usually to consolidate, not to raise the number.
  check('the tool surface stays small enough to not tax the caller', tools.length <= 14, `${tools.length} tools`);
  const names = tools.map((t) => t.name);
  for (const required of ['attach', 'poll', 'advice', 'item', 'working', 'summary', 'transcript']) {
    check(`the ${required} tool exists`, names.includes(required));
  }

  const unknown = await rpc.request('tools/call', { name: 'no_such_tool', arguments: {} });
  check('an unknown tool is a protocol error', unknown.error?.code === -32602, JSON.stringify(unknown));

  // --- attach before any meeting exists ---
  const early = await call(rpc, 'attach');
  check('attach explains itself when no meeting has started', early.isError && /transcript|capturing/i.test(early.text), early.text);

  // Nothing else may be usable before attach: an unpinned write would land on a guessed session.
  const unpinned = await call(rpc, 'advice', { text: 'should not be posted' });
  check('a tool refuses to act before attach', unpinned.isError && /attach/.test(unpinned.text), unpinned.text);

  // --- a meeting appears ---
  const session = '2026-02-02_mcp-test';
  const say = (line) => fetch(`${base}/append`, { method: 'POST', headers: auth, body: JSON.stringify({ session, line }) });
  await say('Ana: we decided to ship the release on Monday.\n'); // "decided" is urgent: the gate releases it
  await sleep(600);

  const attached = await call(rpc, 'attach');
  check('attach pins the active meeting', !attached.isError && attached.data.session === session, attached.text);
  check('attach reports the panel state', !!attached.data?.status, attached.text);
  check('attach hands back a ready-to-run wake loop', /curl .*\/poll\?/.test(attached.data.wakeLoop || ''), attached.data.wakeLoop);
  // The wake loop and this adapter are one assistant with one read position. If attach handed out a
  // different consumer than `poll` uses, each would replay the meeting into the other's blind spot.
  check('the wake loop polls under the same consumer as the poll tool',
    (attached.data.wakeLoop || '').includes('consumer=test-agent'), attached.data.wakeLoop);

  // --- the keystone: poll ---
  const first = await call(rpc, 'poll');
  check('poll returns the transcript batch', !first.isError && /ship the release on Monday/.test(first.data.batch || ''), first.text);
  check('poll returns panel state alongside it', typeof first.data?.status?.state === 'string', first.text);

  const second = await call(rpc, 'poll');
  check('a second poll does not replay the same batch', (second.data.batch || '').length === 0, second.text);

  // poll must read the wake channel, never force it. An earlier version flushed the buffer on every poll
  // "so a poll never waits behind the coalescing window", which handed back every caption the gate was
  // holding - on a 2-second wake loop that is the gate deleted, and roughly 4x the assistant turns.
  await say('Bo: good morning, how are you? weather is nice.\n');
  await say('Ana: haha, thanks. no worries.\n');
  await sleep(800);
  const quiet = await call(rpc, 'poll');
  check('the wake gate still holds back small talk', (quiet.data.batch || '') === '', quiet.text);

  await say('Ana: blocker - the API deploy is rejected until QA signs off.\n');
  await sleep(800);
  const third = await call(rpc, 'poll');
  check('poll picks up substance that arrived after the last poll', /blocker/.test(third.data.batch || ''), third.text);
  check('held small talk rides along with the next real batch instead of being lost', /good morning/.test(third.data.batch || ''), third.text);

  // The offset is per consumer, so a second assistant is not starved by the first one's polls.
  const other = spawn(process.execPath, [path.join(ROOT, 'server', 'mcp-server.js')], {
    env: { ...process.env, MLA_URL: base, MLA_TOKEN: token, TRANSCRIPTS_DIR: dir, MLA_AGENT: 'second-agent' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rpc2 = client(other);
  await rpc2.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke2', version: '0' } });
  const otherAttach = await call(rpc2, 'attach', { session, force: true });
  check('a second consumer can attach with force', !otherAttach.isError, otherAttach.text);
  const otherPoll = await call(rpc2, 'poll', { session });
  check('the poll offset is per consumer, not global', /ship the release on Monday/.test(otherPoll.data.batch || ''), otherPoll.text);
  other.kill('SIGKILL');

  // --- the writes an assistant actually makes ---
  const advice = await call(rpc, 'advice', { text: 'QA is not done - do not commit to Friday', marker: 'RISK' });
  check('advice posts', !advice.isError && advice.data.marker === 'RISK', advice.text);
  const panelSees = await (await fetch(`${base}/advice?session=${encodeURIComponent(session)}&since=0`, { headers: auth })).json();
  check('the panel can read what the MCP tool posted', panelSees.items.some((i) => /do not commit/.test(i.text)), JSON.stringify(panelSees));

  const badMarker = await call(rpc, 'advice', { text: 'x', marker: 'SHOUT' });
  check('an invalid marker degrades to INFO instead of failing', !badMarker.isError && badMarker.data.marker === 'INFO', badMarker.text);

  const item = await call(rpc, 'item', { text: 'Ship on Monday', kind: 'decision', owner: 'Ana' });
  check('a board item posts with its kind and owner', !item.isError && item.data.kind === 'decision' && item.data.owner === 'Ana', item.text);

  const working = await call(rpc, 'working', { status: 'checking the release calendar' });
  check('working heartbeats', !working.isError && working.data.ok === true, working.text);
  const ping = await (await fetch(`${base}/brain-ping?session=${encodeURIComponent(session)}`, { headers: auth })).json();
  check('the heartbeat is visible to the panel', ping.ageMs != null && ping.ageMs < 10000, JSON.stringify(ping));
  check('the panel sees what the assistant is doing', /release calendar/.test(ping.status || ''), JSON.stringify(ping));

  const chat = await call(rpc, 'chat_reply', { text: 'flagged it in the panel' });
  check('chat_reply posts as the agent', !chat.isError, chat.text);
  const chatBack = await (await fetch(`${base}/chat?session=${encodeURIComponent(session)}&since=0`, { headers: auth })).json();
  check('the reply lands in the panel chat as agent', chatBack.items.some((i) => i.role === 'agent' && /flagged it/.test(i.text)), JSON.stringify(chatBack));

  const summary = await call(rpc, 'summary', { markdown: '# Wrap-up\n- Decision: Monday\n' });
  check('summary saves', !summary.isError, summary.text);
  const savedSummary = await (await fetch(`${base}/summary?session=${encodeURIComponent(session)}`, { headers: auth })).json();
  check('the saved summary is the markdown we sent', /Decision: Monday/.test(savedSummary.text || savedSummary.markdown || ''), JSON.stringify(savedSummary));

  // --- transcript is the complete record, not the gated batches ---
  const full = await call(rpc, 'transcript', { tail_lines: 50 });
  check('transcript returns the whole record, small talk included', !full.isError && /Monday/.test(full.data.text || '') && /good morning/.test(full.data.text || ''), full.text);

  const snapReq = await call(rpc, 'snapshot_request');
  check('snapshot_request bumps a request seq', !snapReq.isError && typeof snapReq.data.seq === 'number', snapReq.text);
  const snaps = await call(rpc, 'snapshot_read');
  check('snapshot_read answers with an empty list before any capture', !snaps.isError && Array.isArray(snaps.data.snapshots), snaps.text);

  // --- the assistant must be told to shut up when the user pauses it ---
  await fetch(`${base}/control`, { method: 'POST', headers: auth, body: JSON.stringify({ session, state: 'paused' }) });
  const paused = await call(rpc, 'poll');
  check('poll reports a paused meeting', paused.data?.status?.state === 'paused', paused.text);
  await fetch(`${base}/control`, { method: 'POST', headers: auth, body: JSON.stringify({ session, state: 'running' }) });

  await fetch(`${base}/suppress`, { method: 'POST', headers: auth, body: JSON.stringify({ session, text: 'pricing', kind: 'advice' }) });
  const suppressed = await call(rpc, 'poll');
  check('poll reports topics the user dismissed', JSON.stringify(suppressed.data?.status?.suppress || []).includes('pricing'), suppressed.text);

  // --- the wake loop's view: format=text, empty body means "do not wake anybody" ---
  const textUrl = `${base}/poll?session=${encodeURIComponent(session)}&consumer=wake-loop&format=text`;
  const t1 = await (await fetch(textUrl, { headers: auth })).text();
  check('the text format leads with the panel state', /^state=running mode=auto/.test(t1), JSON.stringify(t1.slice(0, 120)));
  const t2 = await (await fetch(textUrl, { headers: auth })).text();
  check('a quiet meeting produces an empty body, so the loop wakes nobody', t2 === '', JSON.stringify(t2));

  await say('Bo: one more decision - we approved the migration ticket.\n');
  await sleep(800);
  const t3 = await (await fetch(textUrl, { headers: auth })).text();
  check('new captions produce a body without repeating unchanged state', t3.includes('approved the migration') && !t3.includes('state='), JSON.stringify(t3));

  // Pressing Stop used to be silent: capture ended, the transcript stopped growing, nothing woke the
  // assistant, and the wrap-up never got written.
  await fetch(`${base}/control`, { method: 'POST', headers: auth, body: JSON.stringify({ session, state: 'stopped' }) });
  const t4 = await (await fetch(textUrl, { headers: auth })).text();
  check('a state change alone wakes the loop', t4.includes('state=stopped'), JSON.stringify(t4));
  await fetch(`${base}/control`, { method: 'POST', headers: auth, body: JSON.stringify({ session, state: 'running' }) });

  // estTokens grows with every caption. If it were part of the change signature, every poll would look
  // like a state change and the wake gate would be worthless.
  await say('Ana: one more agreed action item, so the estimate grows.\n');
  await sleep(800);
  await (await fetch(textUrl, { headers: auth })).text(); // consume the caption and the running-state change
  const t5 = await (await fetch(textUrl, { headers: auth })).text();
  check('a growing token estimate is not treated as a state change', t5 === '', JSON.stringify(t5));

  // --- a bad token must be a clear message, not a bare 403 ---
  const wrong = spawn(process.execPath, [path.join(ROOT, 'server', 'mcp-server.js')], {
    env: { ...process.env, MLA_URL: base, MLA_TOKEN: 'definitely-wrong', TRANSCRIPTS_DIR: dir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rpc3 = client(wrong);
  await rpc3.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke3', version: '0' } });
  const rejected = await call(rpc3, 'attach', { session });
  check('a wrong token produces an actionable message', rejected.isError && /token/i.test(rejected.text), rejected.text);
  wrong.kill('SIGKILL');

  // --- the server being down is the most common failure and must say so ---
  const orphan = spawn(process.execPath, [path.join(ROOT, 'server', 'mcp-server.js')], {
    env: { ...process.env, MLA_URL: 'http://127.0.0.1:1', MLA_TOKEN: token, TRANSCRIPTS_DIR: dir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rpc4 = client(orphan);
  await rpc4.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke4', version: '0' } });
  const unreachable = await call(rpc4, 'attach', { session });
  check('an unreachable server tells you how to start it', unreachable.isError && /not reachable/.test(unreachable.text) && /meet-live-assist-server/.test(unreachable.text), unreachable.text);
  orphan.kill('SIGKILL');

  check('the adapter wrote nothing to stderr', mcpErr === '', mcpErr.slice(0, 300));
  check('the adapter sent no unsolicited messages', rpc.notes.length === 0, JSON.stringify(rpc.notes).slice(0, 300));
} catch (e) {
  check('the suite ran to completion', false, String((e && e.stack) || e));
} finally {
  if (mcp) mcp.kill('SIGKILL');
  if (bridge) bridge.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);

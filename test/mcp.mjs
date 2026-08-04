// Contract test for the MCP adapter: boot the bridge server on a throwaway port, speak JSON-RPC at
// server/mcp-server.js over stdio, and assert the tools an assistant depends on.
//
//   node test/mcp.mjs
//
// The point of testing at this level is that it needs no browser and no meeting: everything the
// assistant does to a call is an HTTP effect, so a fake transcript pushed through /append is
// indistinguishable from a real one.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  // A meeting name that is the string "undefined" is what a caller writes after interpolating a variable
  // that was never set. Real data on this machine still contains one from the day an interview landed in
  // it. Auto-resolving to it attaches the assistant to a session the panel is not holding, and nothing in
  // the pipeline reports an error - the transcript flows, the advice posts, the panel shows nothing.
  // It is written newer than the real meeting on purpose: "newest wins" is exactly what would pick it.
  writeFileSync(path.join(dir, 'undefined.txt'), 'Someone: this landed in the wrong file.\n');
  const stillPinned = await call(rpc, 'attach');
  check('attach never resolves to an "undefined" session', stillPinned.data.session === session, stillPinned.text);
  rmSync(path.join(dir, 'undefined.txt'), { force: true });

  // The meeting's own date comes from its name. Birth time is reset by a copy or a restore, so on restored
  // data it would claim a meeting from months ago started today.
  check('attach reports the meeting date from its name', attached.data.date === '2026-02-02', JSON.stringify(attached.data.date));

  // --- the keystone: the wake channel ---
  // The wake loop is the reader that matters: it is the only thing that can start an assistant's turn, and
  // `attach` hands out its URL. Test through that URL, not through the tool, because they are deliberately
  // different readers - see below.
  const loopUrl = attached.data.wakeLoop.match(/"(http:[^"]+)"/)[1];
  const loop = () => fetch(loopUrl, { headers: auth }).then((r) => r.text());

  const first = await loop();
  check('the wake loop receives the transcript batch', /ship the release on Monday/.test(first), JSON.stringify(first));
  check('and leads with the panel state', /^state=running mode=auto/.test(first), JSON.stringify(first.slice(0, 80)));
  check('a second read does not replay it', (await loop()) === '', 'expected an empty body');

  // A reader nobody has seen before starts at the END of the channel. Replaying an hour of a meeting into a
  // fresh reader is never what it wanted, and `transcript` exists for catching up deliberately.
  const freshUrl = `${base}/poll?session=${encodeURIComponent(session)}&consumer=brand-new`;
  const fresh = await (await fetch(freshUrl, { headers: auth })).json();
  check('a brand-new reader starts at the end, not at the beginning', fresh.batch === '', JSON.stringify(fresh.batch));
  const withBacklog = await (await fetch(`${base}/poll?session=${encodeURIComponent(session)}&consumer=catch-up&backlog=1`, { headers: auth })).json();
  check('backlog=1 is how a reader asks for the meeting so far', /ship the release on Monday/.test(withBacklog.batch), JSON.stringify(withBacklog.batch));

  // poll must read the wake channel, never force it. An earlier version flushed the buffer on every poll
  // "so a poll never waits behind the coalescing window", which handed back every caption the gate was
  // holding - on a 2-second wake loop that is the gate deleted, and roughly 4x the assistant turns.
  await say('Bo: good morning, how are you? weather is nice.\n');
  await say('Ana: haha, thanks. no worries.\n');
  await sleep(800);
  check('the wake gate still holds back small talk', (await loop()) === '', 'expected an empty body');

  await say('Ana: blocker - the API deploy is rejected until QA signs off.\n');
  await sleep(800);
  const third = await loop();
  check('the loop picks up substance that arrived after the last read', /blocker/.test(third), JSON.stringify(third));
  check('held small talk rides along with the next real batch instead of being lost', /good morning/.test(third), JSON.stringify(third));

  // Reading a cursor is destructive, so the `poll` tool must NOT share the loop's. It used to, and then a
  // mid-turn `poll` - which the skill explicitly permits - swallowed the state change the loop was about to
  // wake on. Stop is the sharpest case: capture ends there, so the loop is its only possible route.
  await fetch(`${base}/control`, { method: 'POST', headers: auth, body: JSON.stringify({ session, state: 'stopped' }) });
  const midTurn = await call(rpc, 'poll');
  check('a mid-turn poll sees the state change', midTurn.data?.status?.state === 'stopped', midTurn.text);
  const loopAfter = await loop();
  check('and the loop still wakes on it afterwards', /state=stopped/.test(loopAfter), JSON.stringify(loopAfter));
  await fetch(`${base}/control`, { method: 'POST', headers: auth, body: JSON.stringify({ session, state: 'running' }) });
  await loop(); // consume the change back to running

  check('poll returns panel state alongside everything else', typeof midTurn.data?.status?.state === 'string', midTurn.text);

  // A consumer name is caller-supplied and survives sanitising as `constructor` or `__proto__`. Looked up
  // on a plain object those inherit from the prototype, so the offset came back as a function, the batch
  // was never non-empty, and that reader was deaf for the rest of the meeting with no error anywhere.
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const r = await (await fetch(`${base}/poll?session=${encodeURIComponent(session)}&consumer=${encodeURIComponent(name)}&backlog=1`, { headers: auth })).json();
    check(`a reader named "${name}" is not deaf`, /ship the release on Monday/.test(r.batch || ''), JSON.stringify(r.batch));
  }

  // Read positions are bounded: `consumer` comes off the query string, so without a cap every value ever
  // used would persist for the life of the meeting and be re-serialised on every snapshot tick.
  for (let i = 0; i < 20; i++) await fetch(`${base}/poll?session=${encodeURIComponent(session)}&consumer=throwaway-${i}`, { headers: auth });
  await sleep(400);
  const stateFile = JSON.parse(readFileSync(path.join(dir, '.state', 'pollOffsets.json'), 'utf8'));
  const kept = Object.keys((stateFile.find(([k]) => k === session) || [null, {}])[1]);
  check('the number of remembered readers is bounded', kept.length <= 8, `${kept.length}: ${kept.join(',')}`);
  // The loop is what must never be evicted, and it will not be: eviction is least-recently-seen and the
  // loop is the reader that polls constantly.
  await loop();
  check('the wake loop keeps its position through eviction', (await loop()) === '', 'the loop lost its place');

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

  // The user typing in the panel is how they talk to the assistant during a call. It must arrive through
  // poll and it must wake the loop: a question typed into a quiet meeting would otherwise wait for the next
  // caption. The assistant's own replies must not come back, or it answers itself.
  await fetch(`${base}/chat`, { method: 'POST', headers: auth, body: JSON.stringify({ session, role: 'user', text: 'what did Bo object to?' }) });
  const withChat = await call(rpc, 'poll');
  check('a message typed in the panel reaches the assistant', (withChat.data.chat || []).some((m) => /Bo object/.test(m.text)), withChat.text);
  await call(rpc, 'chat_reply', { text: 'QA not being done.' });
  const afterReply = await call(rpc, 'poll');
  check('the assistant does not get its own reply back', !(afterReply.data.chat || []).some((m) => /QA not being done/.test(m.text)), afterReply.text);
  check('and the chat cursor advances', (afterReply.data.chat || []).length === 0, afterReply.text);

  // --- the wake loop's view: format=text, empty body means "do not wake anybody" ---
  const textUrl = `${base}/poll?session=${encodeURIComponent(session)}&consumer=wake-loop&format=text`;
  const t1 = await (await fetch(textUrl, { headers: auth })).text();
  check('the text format leads with the panel state', /^state=running mode=auto/.test(t1), JSON.stringify(t1.slice(0, 120)));
  const t2 = await (await fetch(textUrl, { headers: auth })).text();
  check('a quiet meeting produces an empty body, so the loop wakes nobody', t2 === '', JSON.stringify(t2));

  // A typed message alone must produce a body, with no caption involved at all.
  await fetch(`${base}/chat`, { method: 'POST', headers: auth, body: JSON.stringify({ session, role: 'user', text: 'ping from the panel' }) });
  const tChat = await (await fetch(textUrl, { headers: auth })).text();
  check('a typed message alone wakes the loop', /^chat> ping from the panel/m.test(tChat), JSON.stringify(tChat));

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

  // Closing stdin used to exit the process immediately, dropping any tool call still waiting on the bridge
  // server - and every tool call waits on it. A long-lived client keeps stdin open, so this only showed up
  // when piping JSON at the adapter, which is also how anyone would first try it by hand.
  const piped = spawn(process.execPath, [path.join(ROOT, 'server', 'mcp-server.js')], {
    env: { ...process.env, MLA_URL: base, MLA_TOKEN: token, TRANSCRIPTS_DIR: dir, MLA_AGENT: 'piped' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let pipedOut = '';
  piped.stdout.on('data', (c) => { pipedOut += c; });
  piped.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'piped', version: '0' } } })}\n`);
  piped.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'attach', arguments: { session, force: true } } })}\n`);
  piped.stdin.end(); // the whole point: no more input is coming, but a request is still in flight
  await new Promise((resolve) => piped.on('exit', resolve));
  const answered = pipedOut.trim().split('\n').map((l) => { try { return JSON.parse(l); } catch (_) { return {}; } });
  check('a request still in flight is answered before the process exits',
    answered.some((m) => m.id === 2 && m.result && !m.result.isError), pipedOut.slice(0, 200));

  // --- the wake loop's own failure modes ------------------------------------------------------------
  // The loop is the wake source, so its failures cost turns. With a token the server rejects, `curl -s`
  // printed the 403 body - a non-empty body every 2 seconds, i.e. a wake every 2 seconds for as long as
  // the call lasts. It has to say it once and then back off.
  const loopScript = attached.data.wakeLoop.replace(/^T=.*$/m, 'T=definitely-wrong');
  const badToken = spawn('sh', ['-c', loopScript], { stdio: ['ignore', 'pipe', 'pipe'] });
  let badOut = '';
  badToken.stdout.on('data', (c) => { badOut += c; });
  await sleep(6000); // three iterations at the 2s cadence, if it did not back off
  badToken.kill('SIGKILL');
  const complaints = badOut.split('\n').filter((l) => l.trim()).length;
  check('a rejected token is reported once, not on every iteration', complaints === 1, `${complaints} lines: ${JSON.stringify(badOut)}`);
  check('and it says what to do about it', /rejected the token/.test(badOut), JSON.stringify(badOut));

  // A dead server used to be indistinguishable from a quiet meeting: `curl -s` prints nothing and exits
  // non-zero. The loop claims to be the only route by which Stop reaches the assistant, so going blind is
  // the one thing it must not do silently.
  const deadLoop = attached.data.wakeLoop.replace(/http:\/\/127\.0\.0\.1:\d+/, 'http://127.0.0.1:1');
  const dead = spawn('sh', ['-c', deadLoop], { stdio: ['ignore', 'pipe', 'pipe'] });
  let deadOut = '';
  dead.stdout.on('data', (c) => { deadOut += c; });
  await sleep(2500);
  dead.kill('SIGKILL');
  check('an unreachable server is reported, not silence', /cannot reach the bridge server/.test(deadOut), JSON.stringify(deadOut));

  // --- protocol robustness: a bad line must not take the adapter down -------------------------------
  // `null` parses as JSON but is not a request. Destructuring it threw, and the catch handler then threw
  // again reading `msg.id`, so one stray line exited the process and left every later request unanswered.
  const rough = spawn(process.execPath, [path.join(ROOT, 'server', 'mcp-server.js')], {
    env: { ...process.env, MLA_URL: base, MLA_TOKEN: token, TRANSCRIPTS_DIR: dir, MLA_AGENT: 'rough' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rpcRough = client(rough);
  await rpcRough.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'rough', version: '0' } });
  rough.stdin.write('null\n');
  rough.stdin.write('"just a string"\n');
  rough.stdin.write('not json at all\n');
  const survived = await rpcRough.request('ping');
  check('a null, a bare string and a bad line do not kill the adapter', !!survived.result, JSON.stringify(survived));
  // Batching left the protocol after 2025-03-26. It used to be silently discarded, leaving the client to
  // wait forever; an error is the one thing a client can actually act on.
  rough.stdin.write(`${JSON.stringify([{ jsonrpc: '2.0', id: 90, method: 'ping' }])}\n`);
  const batchNote = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 3000);
    const iv = setInterval(() => {
      const m = rpcRough.notes.find((n) => n.includes('batched'));
      if (m) { clearInterval(iv); clearTimeout(t); resolve(m); }
    }, 100);
  });
  check('a batched request is refused rather than silently dropped', !!batchNote, JSON.stringify(rpcRough.notes).slice(0, 200));
  rough.kill('SIGKILL');

  // The claim name must be stable across a restart of the adapter AND distinct between assistants. With a
  // fixed default it was stable but not distinct, so two agents that never set MLA_AGENT both looked like
  // the same one and both attached to the same call - the double-assist this rule exists to prevent.
  const named = (cwd) => new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'mcp-server.js')], {
      cwd, env: { ...process.env, MLA_URL: base, MLA_TOKEN: token, TRANSCRIPTS_DIR: dir, MLA_AGENT: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const c = client(proc);
    c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'n', version: '0' } })
      .then(() => call(c, 'attach', { session, force: true }))
      .then((r) => { proc.kill('SIGKILL'); resolve(r); });
  });
  const fromDir = await named(ROOT);
  await named(path.join(ROOT, 'test'));
  const claim = await (await fetch(`${base}/brain-ping?session=${encodeURIComponent(session)}`, { headers: auth })).json();
  check('an assistant with no MLA_AGENT is named after its working directory', claim.agent === 'test', JSON.stringify(claim.agent));
  check('so two assistants in different projects are not the same claimant', !fromDir.isError, fromDir.text);

  // --- attach must not refuse the meeting it is already assisting -----------------------------------
  // The heartbeat it checks is bumped by its own `working` calls, so without comparing the claim name an
  // adapter restarted mid-call - a client reconnecting, which is routine - saw its own liveness and
  // refused. The skill's documented answer to a refusal is to stop and tell the user, so this cost the
  // assistant the rest of the call.
  // An earlier check in this suite took the claim on purpose, so take it back first: the point here is a
  // restart of the assistant that currently holds the meeting.
  await call(rpc, 'attach', { session, force: true });
  await call(rpc, 'working', { status: '' });
  const rejoin = spawn(process.execPath, [path.join(ROOT, 'server', 'mcp-server.js')], {
    env: { ...process.env, MLA_URL: base, MLA_TOKEN: token, TRANSCRIPTS_DIR: dir, MLA_AGENT: 'test-agent' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rpcRejoin = client(rejoin);
  await rpcRejoin.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'rejoin', version: '0' } });
  const reattached = await call(rpcRejoin, 'attach', { session });
  check('the same assistant can re-attach to its own live meeting', !reattached.isError, reattached.text);
  rejoin.kill('SIGKILL');

  // A different assistant is still refused, which is the rule this was protecting.
  const rival = spawn(process.execPath, [path.join(ROOT, 'server', 'mcp-server.js')], {
    env: { ...process.env, MLA_URL: base, MLA_TOKEN: token, TRANSCRIPTS_DIR: dir, MLA_AGENT: 'rival-agent' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rpcRival = client(rival);
  await rpcRival.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'rival', version: '0' } });
  const refused = await call(rpcRival, 'attach', { session });
  check('a different assistant is still refused', refused.isError && /already live/.test(refused.text), refused.text);
  const forced = await call(rpcRival, 'attach', { session, force: true });
  check('and can still take over on purpose', !forced.isError, forced.text);
  rival.kill('SIGKILL');
  await call(rpc, 'attach', { session, force: true }); // take our meeting back for the rest of the suite

  // --- two tool calls in one turn must not write to the previous meeting ----------------------------
  // `pinned` is set only after attach's round trips, so a write issued alongside it read the old session.
  // Reproduced: advice meant for meeting B landed in meeting A.
  const otherSession = '2026-02-03_second-meeting';
  await fetch(`${base}/append`, { method: 'POST', headers: auth, body: JSON.stringify({ session: otherSession, line: 'Cy: we decided to start a separate call.\n' }) });
  await Promise.all([
    call(rpc, 'attach', { session: otherSession, force: true }),
    call(rpc, 'advice', { text: 'this belongs to the second meeting', marker: 'INFO' }),
  ]);
  const secondBoard = await (await fetch(`${base}/advice?session=${encodeURIComponent(otherSession)}&since=0`, { headers: auth })).json();
  const firstBoard = await (await fetch(`${base}/advice?session=${encodeURIComponent(session)}&since=0`, { headers: auth })).json();
  check('advice sent alongside an attach lands on the meeting that attach pinned',
    secondBoard.items.some((i) => /second meeting/.test(i.text)), JSON.stringify(secondBoard.items));
  check('and not on the previous one',
    !firstBoard.items.some((i) => /second meeting/.test(i.text)), JSON.stringify(firstBoard.items.map((i) => i.text)));
  await call(rpc, 'attach', { session, force: true });

  // --- a chat-only session must be attachable -------------------------------------------------------
  // This is the documented recovery from the `undefined` incident: ask the user to type in the panel, then
  // attach to whatever session that arrived under. In exactly that scenario the panel's session has only a
  // chat file, because the transcript is going to the wrong one.
  const chatOnly = '2026-02-04_chat-only';
  await fetch(`${base}/chat`, { method: 'POST', headers: auth, body: JSON.stringify({ session: chatOnly, role: 'user', text: 'x' }) });
  const attachedChatOnly = await call(rpc, 'attach', { session: chatOnly, force: true });
  check('a session with only a chat file can still be attached', !attachedChatOnly.isError && attachedChatOnly.data.session === chatOnly, attachedChatOnly.text);
  await call(rpc, 'attach', { session, force: true });

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

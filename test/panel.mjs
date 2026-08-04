// The panel's side of the contract, replayed without a browser.
//
//   node test/panel.mjs
//
// Every request here is one the side panel actually makes (src/sidepanel.js), in the shape it makes it,
// including the `since` cursors it keeps. The server has no idea a browser is missing. This exists because
// the panel is the half of the product a headless server test never touches: a route renamed, a field
// dropped, or a `since` that stops advancing all look fine from the assistant's side and leave the user
// staring at an empty panel - which has happened.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

const ROOT = path.resolve(import.meta.dirname, '..');
const dir = mkdtempSync(path.join(tmpdir(), 'mla-panel-'));
let failures = 0;
let server;

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

try {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'transcript-server.js')], {
    // A short staleness window so the 🧠 pill's age filter can be tested without waiting out 45s.
    env: { ...process.env, PORT: String(port), TRANSCRIPTS_DIR: dir, STATE_SNAPSHOT_MS: '150', BRAIN_STALE_MS: '700' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  server.stderr.on('data', (c) => { err += c; });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { up = (await fetch(`${base}/health`)).ok; } catch (_) { await sleep(250); }
  }
  if (!up) throw new Error(`server never came up\n${err}`);

  const token = readFileSync(path.join(dir, '.mla-token'), 'utf8').trim();
  // hdrs() / hdrs(true) in sidepanel.js.
  const hdrs = (body) => (body ? { 'Content-Type': 'application/json', 'X-MLA-Token': token } : { 'X-MLA-Token': token });
  const session = '2026-03-03_panel-test';
  const q = encodeURIComponent(session);
  const get = (route) => fetch(`${base}${route}`, { headers: hdrs() });
  const post = (route, body) => fetch(`${base}${route}`, { method: 'POST', headers: hdrs(true), body: JSON.stringify(body) });

  // The panel's own cursors. Every one of these must advance, or the panel re-renders the same item
  // forever or never renders the next one.
  let lastAdviceSeq = 0, lastItemsSeq = 0, lastChatSeq = 0, lastCallChatSeq = -1;

  // --- what the panel does on open, before a token is even pasted (fetchHealth / pollServerHealth) ---
  const health = await (await fetch(`${base}/health`)).json();
  check('the panel can read /health with no token', health.ok === true);
  const authCheck = await (await get('/auth-check')).json();
  check('/auth-check tells the panel the token works', authCheck.authed === true);

  // --- capture: the content script posting captions (background.js -> /append) ---
  const captured = await post('/append', { session, line: 'Ann: we decided to cut scope for the release.\n' });
  check('a caption is accepted', captured.status === 204, `status ${captured.status}`);

  // --- setSession(): the panel syncing itself to a meeting ---
  await post('/mode', { session, mode: 'lead' });
  const mode = await (await get(`/mode?session=${q}`)).json();
  check('the panel reads back the meeting mode it set', mode.mode === 'lead', JSON.stringify(mode));
  const ap0 = await (await get(`/autopilot?session=${q}`)).json();
  check('autopilot defaults to off for a fresh meeting', ap0.create === false && ap0.postChat === false, JSON.stringify(ap0));
  const drive0 = await (await get(`/drive?session=${q}`)).json();
  check('drive defaults to off for a fresh meeting', drive0.on === false, JSON.stringify(drive0));

  // --- the poll cycle, in the order sidepanel.js runs it ---
  await post('/advice', { session, marker: 'SAY', text: 'Ask what "cut scope" means concretely.' });
  const advice = await (await get(`/advice?session=${q}&since=${lastAdviceSeq}`)).json();
  check('advice arrives for the panel to render', advice.items.length === 1 && advice.items[0].marker === 'SAY', JSON.stringify(advice.items));
  lastAdviceSeq = advice.last;
  const adviceAgain = await (await get(`/advice?session=${q}&since=${lastAdviceSeq}`)).json();
  check('the advice cursor advances, so nothing is rendered twice', adviceAgain.items.length === 0, JSON.stringify(adviceAgain.items));

  await post('/items', { session, kind: 'decision', text: 'Cut scope', owner: 'Ann', blockedBy: '' });
  const items = await (await get(`/items?session=${q}&since=${lastItemsSeq}`)).json();
  check('board items arrive with owner and kind', items.items.length === 1 && items.items[0].owner === 'Ann', JSON.stringify(items.items));
  lastItemsSeq = items.last;
  check('the board cursor advances', (await (await get(`/items?session=${q}&since=${lastItemsSeq}`)).json()).items.length === 0);

  // Chat is two-way: the user types (role user), the assistant answers (role agent). The panel must see
  // both, and its cursor must not skip its own message.
  await post('/chat', { session, role: 'user', text: 'what did they decide?' });
  await post('/chat', { session, role: 'agent', text: 'To cut scope, owner Ann.' });
  const chat = await (await get(`/chat?session=${q}&since=${lastChatSeq}`)).json();
  check('the panel sees both sides of the chat', chat.items.length === 2 && chat.items.map((i) => i.role).join() === 'user,agent', JSON.stringify(chat.items));
  lastChatSeq = chat.last;

  const bp = await (await get(`/brain-ping?session=${q}`)).json();
  check('a meeting with no assistant reports no heartbeat', bp.ageMs === null, JSON.stringify(bp));
  check('and names no assistant', bp.agent === null, JSON.stringify(bp));
  await post('/brain-takeover', { session, agent: 'panel-test' });
  await post('/brain-ping', { session, status: 'reading the shared slide' });
  const bp2 = await (await get(`/brain-ping?session=${q}`)).json();
  check('the 🧠 pill sees a fresh heartbeat', bp2.ageMs != null && bp2.ageMs < 5000, JSON.stringify(bp2));
  check('the working bubble carries the activity text', bp2.status === 'reading the shared slide', JSON.stringify(bp2));
  check('and the claimed assistant is named while it is alive', bp2.agent === 'panel-test', JSON.stringify(bp2));
  check('the panel gets a token estimate to display', typeof bp2.estTokens === 'number' && bp2.estTokens > 0, JSON.stringify(bp2));

  // A claim outlives the assistant that made it. Reporting its name after the heartbeat stops puts a 🧠
  // pill on a panel nobody is behind, which reads as "an agent is helping you" when none is.
  await sleep(900);
  const bp3 = await (await get(`/brain-ping?session=${q}`)).json();
  check('a claim from an assistant that stopped heartbeating is not reported', bp3.agent === null, JSON.stringify(bp3));
  check('and the heartbeat age still tells the truth', bp3.ageMs >= 700, JSON.stringify(bp3));
  await post('/brain-ping', { session, status: 'reading the shared slide' }); // back to live for the rest

  const snapSeq = await (await get(`/snapshot-request?session=${q}`)).json();
  check('the panel polls the snapshot request counter', typeof snapSeq.seq === 'number', JSON.stringify(snapSeq));
  await post('/snapshot-request', { session });
  const snapSeq2 = await (await get(`/snapshot-request?session=${q}`)).json();
  check('an assistant request bumps the counter the panel watches', snapSeq2.seq === snapSeq.seq + 1, `${snapSeq.seq} -> ${snapSeq2.seq}`);

  const cc = await (await get(`/callchat?session=${q}&since=${Math.max(lastCallChatSeq, 0)}`)).json();
  check('the meeting-chat queue starts empty', cc.items.length === 0, JSON.stringify(cc.items));
  await post('/callchat', { session, text: 'Ticket: EXAMPLE-1' });
  const cc2 = await (await get(`/callchat?session=${q}&since=0`)).json();
  check('a queued meeting-chat message reaches the panel to type', cc2.items.length === 1 && /EXAMPLE-1/.test(cc2.items[0].text), JSON.stringify(cc2.items));
  // The panel reports back whether it managed to type it, and the assistant reads that on its next poll.
  await post('/callchat-result', { session, seq: cc2.items[0].seq, ok: false, reason: 'chat panel not open' });
  const ccr = await (await get(`/callchat-result?session=${q}&since=0`)).json();
  check('the panel can report a delivery failure', ccr.items.length === 1 && ccr.items[0].ok === false, JSON.stringify(ccr.items));
  // backlog=1 mirrors what `attach` seeds for a real assistant: a reader created from nothing starts at
  // the end, so without it this delivery failure predates its position.
  const assistantSees = await (await get(`/poll?session=${q}&consumer=brain&backlog=1`)).json();
  check('and the assistant is told about it on its next poll',
    assistantSees.pending.callChatResults.some((r) => r.ok === false), JSON.stringify(assistantSees.pending));

  // --- the panel's controls, which the assistant reads as state ---
  await post('/control', { session, state: 'paused' });
  const paused = await (await get(`/control?session=${q}`)).json();
  check('pause is readable by the panel itself', paused.state === 'paused', JSON.stringify(paused));
  check('and the assistant sees it',
    (await (await get(`/poll?session=${q}&consumer=brain`)).json()).status.state === 'paused');
  await post('/control', { session, state: 'running' });

  await post('/suppress', { session, text: 'pricing', kind: 'advice' });
  const sup = await (await get(`/suppress?session=${q}`)).json();
  check('a dismissed topic is recorded', sup.items.some((i) => i.text === 'pricing'), JSON.stringify(sup.items));

  await post('/autopilot', { session, create: true, postChat: false });
  const ap = await (await get(`/autopilot?session=${q}`)).json();
  check('autopilot survives the round trip with postChat still off', ap.create === true && ap.postChat === false, JSON.stringify(ap));

  await post('/context', { session, text: 'Attendees: Ann, Bob. Topic: release scope.' });
  const transcript = readFileSync(path.join(dir, `${session}.txt`), 'utf8');
  check('pasted context lands in the transcript', /release scope/.test(transcript));

  await post('/summary', { session, text: '# Wrap-up\n- Cut scope\n' });
  const summary = await (await get(`/summary?session=${q}`)).json();
  check('the 📄 button has a summary to offer', /Cut scope/.test(summary.text || summary.markdown || ''), JSON.stringify(summary));

  // --- 🗑 wipe this meeting ---
  const cleared = await post('/clear', { session });
  check('the wipe button is accepted', cleared.ok, `status ${cleared.status}`);
  const afterClear = await (await get(`/advice?session=${q}&since=0`)).json();
  check('advice is gone after a wipe', afterClear.items.length === 0, JSON.stringify(afterClear.items));
  const chatAfter = await (await get(`/chat?session=${q}&since=0`)).json();
  check('so is the chat', chatAfter.items.length === 0, JSON.stringify(chatAfter.items));
  const modeAfter = await (await get(`/mode?session=${q}`)).json();
  check('and the meeting is back to defaults', modeAfter.mode === 'auto', JSON.stringify(modeAfter));

  check('the server logged no errors through all of it', !/Error|error:/.test(err), err.slice(0, 300));
} catch (e) {
  check('the suite ran to completion', false, String((e && e.stack) || e));
} finally {
  if (server) server.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);

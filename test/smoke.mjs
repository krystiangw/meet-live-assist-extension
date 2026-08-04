// Smoke test for the bridge server: boot it on a throwaway port + data dir, then assert the contract the
// extension and the brain actually depend on. No dependencies, no network beyond loopback.
//
//   node test/smoke.mjs
//
// Each check below exists because breaking it silently is expensive: the auth gate is the only thing
// standing between a visited web page and /edit, the session guard is what stopped an hour of a real
// interview landing in `undefined.txt`, and the advice round-trip is the whole point of the server.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

const ROOT = path.resolve(import.meta.dirname, '..');
const dir = mkdtempSync(path.join(tmpdir(), 'mla-smoke-'));
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

// SNAPSHOT_MS shortens the state store's snapshot interval so the restart check below does not have to
// wait out the production default. Durability is the contract under test, not the period.
const SNAPSHOT_MS = 150;

async function boot(port) {
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'transcript-server.js')], {
    env: { ...process.env, PORT: String(port), TRANSCRIPTS_DIR: dir, STATE_SNAPSHOT_MS: String(SNAPSHOT_MS) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c; });

  // /health is the only unauthenticated route, so it is also the readiness probe.
  let health = null;
  for (let i = 0; i < 40 && !health; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) health = await r.json(); } catch (_) { await sleep(250); }
  }
  if (!health) throw new Error(`server never answered /health on ${port}\n${stderr}`);
  return { proc, base, health };
}

try {
  const port = await freePort();
  let base, health;
  ({ proc: server, base, health } = await boot(port));
  check('/health responds without a token', health.ok === true);
  check('/health reports the data dir it was given', health.dir === dir, `got ${health.dir}`);

  const tokenFile = path.join(dir, '.mla-token');
  check('first boot mints the auth token', existsSync(tokenFile));
  const token = readFileSync(tokenFile, 'utf8').trim();
  check('token is long enough to not be guessable', token.length >= 32, `${token.length} chars`);

  const auth = { 'Content-Type': 'application/json', 'X-MLA-Token': token };
  const session = '2026-01-01_smoke-test';

  // /auth-check must answer 200 either way: the panel polls it before a token exists, and a 403 there put a
  // console error on every poll of a brand-new install.
  const authNo = await fetch(`${base}/auth-check`);
  check('/auth-check answers 200 without a token', authNo.status === 200, `status ${authNo.status}`);
  check('/auth-check reports authed:false without a token', authNo.ok && (await authNo.json()).authed === false);
  const authYes = await fetch(`${base}/auth-check`, { headers: { 'X-MLA-Token': token } });
  check('/auth-check reports authed:true with the token', authYes.ok && (await authYes.json()).authed === true);
  const authBad = await fetch(`${base}/auth-check`, { headers: { 'X-MLA-Token': 'wrong' } });
  check('/auth-check reports authed:false for a wrong token', authBad.ok && (await authBad.json()).authed === false);

  const noToken = await fetch(`${base}/append`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, line: 'should never be written\n' }),
  });
  check('an unauthenticated write is refused', noToken.status === 403, `status ${noToken.status}`);

  const badToken = await fetch(`${base}/append`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MLA-Token': 'wrong' },
    body: JSON.stringify({ session, line: 'should never be written\n' }),
  });
  check('a wrong token is refused', badToken.status === 403, `status ${badToken.status}`);

  // The literal string "undefined" is what a caller sends after interpolating a variable that was never
  // set. Accepting it created a transcript the panel could not display anything from.
  const noSession = await fetch(`${base}/append`, {
    method: 'POST', headers: auth, body: JSON.stringify({ session: 'undefined', line: 'x\n' }),
  });
  check('a session-less append is rejected', noSession.status === 400, `status ${noSession.status}`);

  // "decided" is one of the words the wake gate treats as urgent, so this line reaches the .wake
  // channel promptly and the poll check further down has something to read.
  const line = 'Speaker: we decided this line must reach the transcript.\n';
  const appended = await fetch(`${base}/append`, { method: 'POST', headers: auth, body: JSON.stringify({ session, line }) });
  check('an authenticated append is accepted', appended.status === 204, `status ${appended.status}`);

  const transcript = path.join(dir, `${session}.txt`);
  check('the transcript file is created', existsSync(transcript));
  check('the appended line is in the transcript', existsSync(transcript) && readFileSync(transcript, 'utf8').includes(line));

  // The brain posts advice, the panel polls it back. This round trip is the product.
  const posted = await fetch(`${base}/advice`, {
    method: 'POST', headers: auth, body: JSON.stringify({ session, marker: 'RISK', text: 'a risk worth flagging' }),
  });
  check('advice is accepted', posted.ok, `status ${posted.status}`);
  const item = posted.ok ? await posted.json() : {};
  check('advice keeps the marker it was given', item.marker === 'RISK', `got ${item.marker}`);

  const polled = await fetch(`${base}/advice?session=${encodeURIComponent(session)}&since=0`, { headers: auth });
  const { items, last } = await polled.json();
  check('advice polls back', items.length === 1 && items[0].text === 'a risk worth flagging', JSON.stringify(items));
  check('the sequence number advances', last === 1, `got ${last}`);

  // `since` is how the panel avoids replaying advice it already rendered.
  const { items: none } = await (await fetch(`${base}/advice?session=${encodeURIComponent(session)}&since=${last}`, { headers: auth })).json();
  check('polling past the last seq returns nothing', none.length === 0, JSON.stringify(none));

  // Path traversal: a hostile session name must not escape the data dir.
  await fetch(`${base}/append`, { method: 'POST', headers: auth, body: JSON.stringify({ session: '../escaped', line: 'x\n' }) });
  check('a traversing session name stays inside the data dir', !existsSync(path.join(dir, '..', 'escaped.txt')));

  // Restart survival. Advice and the board used to live in plain Maps, so bouncing the server mid-call
  // silently dropped them - which is why the docs said never to restart during a meeting. SIGKILL, not
  // SIGTERM, because the exit handler's flush must not be what makes this pass: the periodic snapshot
  // has to stand on its own. The board is the sharper case of the two, since /items mutates the list in
  // place and never calls set() again - and set() runs before the first push, so a write-through-on-set
  // store would persist an empty board.
  const boardPost = await fetch(`${base}/items`, {
    method: 'POST', headers: auth, body: JSON.stringify({ session, kind: 'decision', text: 'ship the store refactor' }),
  });
  check('a board item is accepted', boardPost.ok, `status ${boardPost.status}`);
  await fetch(`${base}/items`, { method: 'POST', headers: auth, body: JSON.stringify({ session, kind: 'action', text: 'second item, added in place' }) });

  // Consume the wake channel first, so the restart can prove the read offset is durable too. Without
  // that, a restarted assistant replays the whole meeting as if it were new and re-advises all of it.
  const pollUrl = `${base}/poll?session=${encodeURIComponent(session)}&consumer=smoke`;
  await sleep(600); // let the wake gate release the urgent line
  const firstPoll = await (await fetch(pollUrl, { headers: auth })).json();
  check('poll returns the batch the wake gate released', firstPoll.batch.includes('must reach the transcript'), JSON.stringify(firstPoll.batch));

  await sleep(SNAPSHOT_MS * 4);
  server.kill('SIGKILL');
  await sleep(300);
  check('state was snapshotted to disk', existsSync(path.join(dir, '.state', 'advice.json')));

  ({ proc: server, base } = await boot(port));
  const afterAdvice = await (await fetch(`${base}/advice?session=${encodeURIComponent(session)}&since=0`, { headers: auth })).json();
  check('advice survives a restart', afterAdvice.items.length === 1 && afterAdvice.items[0].text === 'a risk worth flagging', JSON.stringify(afterAdvice));
  check('the advice seq resumes rather than restarting at 0', afterAdvice.last === 1, `got ${afterAdvice.last}`);
  const afterBoard = await (await fetch(`${base}/items?session=${encodeURIComponent(session)}&since=0`, { headers: auth })).json();
  check('both board items survive a restart', afterBoard.items.length === 2, JSON.stringify(afterBoard));
  check('the in-place board mutation was persisted, not just the first item',
    afterBoard.items.some((i) => i.text === 'second item, added in place'), JSON.stringify(afterBoard));

  const afterPoll = await (await fetch(pollUrl, { headers: auth })).json();
  check('the poll offset survives a restart, so nothing is replayed', afterPoll.batch === '', JSON.stringify(afterPoll.batch));

  // The token is the same file, so the same header must keep working after the restart.
  const afterAuth = await fetch(`${base}/auth-check`, { headers: { 'X-MLA-Token': token } });
  check('the token still authenticates after a restart', afterAuth.ok && (await afterAuth.json()).authed === true);

  // /clear is the "wipe this meeting" button. It must clear persisted state too, or the next boot
  // resurrects a meeting the user deleted.
  await fetch(`${base}/clear`, { method: 'POST', headers: auth, body: JSON.stringify({ session }) });
  await sleep(SNAPSHOT_MS * 4);
  server.kill('SIGKILL');
  await sleep(300);
  ({ proc: server, base } = await boot(port));
  const afterClear = await (await fetch(`${base}/advice?session=${encodeURIComponent(session)}&since=0`, { headers: auth })).json();
  check('a cleared meeting does not come back after a restart', afterClear.items.length === 0, JSON.stringify(afterClear));
} catch (e) {
  check('the suite ran to completion', false, String(e && e.message || e));
} finally {
  if (server) server.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);

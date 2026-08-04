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

try {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'transcript-server.js')], {
    env: { ...process.env, PORT: String(port), TRANSCRIPTS_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  server.stderr.on('data', (c) => { stderr += c; });

  // /health is the only unauthenticated route, so it is also the readiness probe.
  let health = null;
  for (let i = 0; i < 40 && !health; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) health = await r.json(); } catch (_) { await sleep(250); }
  }
  if (!health) throw new Error(`server never answered /health on ${port}\n${stderr}`);
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

  const line = 'Speaker: this line must reach the transcript.\n';
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
} catch (e) {
  check('the suite ran to completion', false, String(e && e.message || e));
} finally {
  if (server) server.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);

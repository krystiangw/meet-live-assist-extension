// What happens when the wake channel cannot be written.
//
//   node test/wake-failure.mjs
//
// The transcript file and the wake channel are separate writes. The .txt is the complete record; the .wake
// channel is the only thing the assistant is ever handed. So a failure to write the channel does not lose the
// conversation - it makes the assistant blind to a stretch of it while everything else looks healthy, which
// is precisely the failure mode this project has paid for twice.
//
// It used to be worse than blind: `b.lines = []` sat outside the try, so a failed write discarded the speech
// that had not been delivered yet. This suite makes the channel genuinely unwritable (a directory where the
// file should be) and asserts that the lines survive, that the failure is reported, and that a later
// successful write delivers everything that was held.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

const ROOT = path.resolve(import.meta.dirname, '..');
const dir = mkdtempSync(path.join(tmpdir(), 'mla-wakefail-'));
let failures = 0;
let server;

function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok || !detail ? '' : ` - ${detail}`}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const SESSION = '2026-01-01_wake-failure';

try {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  // Make the wake channel unwritable in a way no permission trick can be fooled by: put a DIRECTORY exactly
  // where the file has to go. appendFileSync then fails with EISDIR every time, deterministically, on any OS
  // and regardless of whether the suite runs as root.
  mkdirSync(path.join(dir, `${SESSION}.wake`), { recursive: true });

  server = spawn(process.execPath, [path.join(ROOT, 'server', 'transcript-server.js')], {
    env: { ...process.env, PORT: String(port), TRANSCRIPTS_DIR: dir, WAKE_ALL: '1', CAPTURE_STALL_MS: '800' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  server.stderr.on('data', (c) => { stderr += c; });

  let health = null;
  for (let i = 0; i < 40 && !health; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) health = await r.json(); } catch (_) { await sleep(150); }
  }
  if (!health) throw new Error(`server never answered /health\n${stderr}`);

  const token = readFileSync(path.join(dir, '.mla-token'), 'utf8').trim();
  const auth = { 'Content-Type': 'application/json', 'X-MLA-Token': token };

  const say = (text) => fetch(`${base}/append`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ session: SESSION, line: `[10:00:00] Bob: ${text}\n` }),
  });

  // WAKE_ALL=1 so every line is released immediately and each append attempts a write.
  await say('we agreed the deadline is Friday');
  await say('and the blocker is the migration');
  await sleep(400);

  // The server must still be serving. A throw inside the flush used to be caught, but the buffer was cleared
  // regardless; the point here is that neither the process nor the data goes away.
  const stillUp = await fetch(`${base}/health`).then((r) => r.ok).catch(() => false);
  check('the server survives a wake channel it cannot write', stillUp);

  // The transcript is the complete record and must be untouched by any of this.
  const txt = path.join(dir, `${SESSION}.txt`);
  const body = existsSync(txt) ? readFileSync(txt, 'utf8') : '';
  check('the transcript still has every line', body.includes('deadline is Friday') && body.includes('the migration'),
    JSON.stringify(body.slice(-120)));

  // The failure has to reach someone. The panel polls this shape every couple of seconds.
  const status = await (await fetch(`${base}/poll?session=${SESSION}&consumer=probe&statusOnly=1`, { headers: auth })).json();
  check('the status reports the wake channel is failing', !!(status.status && status.status.wakeError),
    JSON.stringify(status.status && status.status.wakeError));

  // And the assistant's own wake loop reads the text form, so it must say so there too.
  const text = await (await fetch(`${base}/poll?session=${SESSION}&consumer=probe2&format=text`, { headers: auth })).text();
  check('and the assistant is told, not just left receiving nothing', text.includes('WAKE-WRITE-FAILING'),
    JSON.stringify(text.slice(0, 200)));

  // brain-ping is what the PANEL polls, so the failure has to be visible there too - it is the only surface
  // the user is looking at during a call. Asserted while the failure is still live: checking it after the
  // obstruction is cleared would pass whether or not the field was ever populated.
  const ping = await (await fetch(`${base}/brain-ping?session=${SESSION}`, { headers: auth })).json();
  check("the panel's own poll carries the failure", !!(ping.wakeError && ping.wakeError.message),
    JSON.stringify(ping.wakeError));

  // Now clear the obstruction. The held lines must arrive - that is the whole point of not discarding them.
  rmSync(path.join(dir, `${SESSION}.wake`), { recursive: true, force: true });
  await say('and here is the third line');
  await sleep(500);

  const wake = path.join(dir, `${SESSION}.wake`);
  const delivered = existsSync(wake) ? readFileSync(wake, 'utf8') : '';
  check('the lines held during the failure are delivered once the write succeeds',
    delivered.includes('deadline is Friday') && delivered.includes('the migration'),
    JSON.stringify(delivered.slice(0, 200)));
  check('together with the line that came after it', delivered.includes('the third line'));

  const after = await (await fetch(`${base}/poll?session=${SESSION}&consumer=probe3&statusOnly=1`, { headers: auth })).json();
  check('and the failure report clears once it is writing again', !(after.status && after.status.wakeError),
    JSON.stringify(after.status && after.status.wakeError));
  // Capture stalling is the third member of the "everything looks green and nothing is arriving" family, and
  // historically the most expensive: a broken content script and a quiet room are indistinguishable from the
  // server's side. CAPTURE_STALL_MS is turned right down for the test; the contract is the signal, not 5 min.
  const stallSession = '2026-01-01_stall';
  await fetch(`${base}/append`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ session: stallSession, line: '[10:00:00] Bob: one line, then nothing\n' }),
  });
  const fresh = await (await fetch(`${base}/brain-ping?session=${stallSession}`, { headers: auth })).json();
  check('a session that just received a line is not reported as stalled', !fresh.captureStall,
    JSON.stringify(fresh.captureStall));
  await sleep(1200); // CAPTURE_STALL_MS is 800 in this suite's env
  const stalled = await (await fetch(`${base}/brain-ping?session=${stallSession}`, { headers: auth })).json();
  check('and one that has gone quiet past the threshold is', !!(stalled.captureStall && stalled.captureStall.idleMs >= 800),
    JSON.stringify(stalled.captureStall));
  const loopText = await (await fetch(`${base}/poll?session=${stallSession}&consumer=stallprobe&format=text`, { headers: auth })).text();
  check('and the assistant is told on its own channel', loopText.includes('CAPTURE-STALLED'), JSON.stringify(loopText.slice(0, 160)));

} catch (e) {
  check('the suite ran to completion', false, String((e && e.stack) || e));
} finally {
  // Wait for the process to actually go before removing the directory it is still writing into, or the
  // cleanup races the final state snapshot and throws ENOTEMPTY over a suite that passed.
  if (server) {
    try { server.kill(); } catch (_) {}
    await new Promise((r) => { server.once('exit', r); setTimeout(r, 3000); });
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);

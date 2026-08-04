// What happens at the size caps, with text that is not ASCII.
//
//   node test/limits.mjs
//
// Every other suite here uses English, so the byte/character distinction never shows up. A review found
// three defects hiding behind that: the wake channel cut mid-character, /transcript's cap counted UTF-16
// code units against a byte limit (letting through half again as much on Polish, 3x on emoji) and could
// leave a lone surrogate at the cut, and `lines` described what was asked for rather than what came back.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

const ROOT = path.resolve(import.meta.dirname, '..');
const dir = mkdtempSync(path.join(tmpdir(), 'mla-limits-'));
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
const CAP = 64 * 1024; // POLL_MAX_BYTES

// The cut helper, directly. Its failure modes are silent: reporting more than was read advances a reader
// past captions nobody saw, and reporting zero when a usable prefix exists stalls that reader for good.
// Neither shows up through the HTTP checks below unless the input happens to be adversarial.
{
  const { utf8SafeCut } = await import(new URL('../server/wake-cut.js', import.meta.url));
  const two = Buffer.from('ą');   // 2 bytes
  const four = Buffer.from('🔵'); // 4 bytes, a surrogate pair in UTF-16
  const cases = [
    ['an empty read reports nothing to consume', Buffer.from(''), 0, 0],
    ['a length of zero never looks past it', Buffer.from('a\nb'), 0, 0],
    ['plain ascii with no newline is taken whole', Buffer.from('abcdef'), 6, 6],
    ['a lone lead byte at the end is held back', Buffer.concat([Buffer.from('ab'), four.slice(0, 1)]), 3, 2],
    ['so is a partial 4-byte sequence', Buffer.concat([Buffer.from('ab'), four.slice(0, 3)]), 5, 2],
    ['and a partial 2-byte one', Buffer.concat([Buffer.from('ab'), two.slice(0, 1)]), 3, 2],
    ['a complete sequence is not held back', Buffer.from('ab🔵'), 6, 6],
    ['a newline wins over character arithmetic', Buffer.from('ab\nc\xc4'), 5, 3],
    ['a length beyond the buffer is clamped', Buffer.from('abc'), 99, 3],
  ];
  for (const [name, buf, len, want] of cases) {
    const got = utf8SafeCut(buf, len);
    check(name, got === want, `got ${got}, wanted ${want}`);
  }
  // The invariant that matters most, over inputs nobody designed: never report more than was read.
  let overflow = 0;
  const fuzz = Buffer.concat([Buffer.from('Zażółć gęślą 🔵\n'), Buffer.from([0x80, 0xc4, 0xff, 0xf0, 0x9f])]);
  for (let len = 0; len <= fuzz.length + 3; len++) if (utf8SafeCut(fuzz, len) > len) overflow++;
  check('no length ever cuts past what was read', overflow === 0, `${overflow} overflowing lengths`);
}

try {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  // WAKE_ALL so every line reaches the channel: this suite is about size, not about the gate's judgement.
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'transcript-server.js')], {
    env: { ...process.env, PORT: String(port), TRANSCRIPTS_DIR: dir, STATE_SNAPSHOT_MS: '150', WAKE_ALL: '1' },
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
  const auth = { 'Content-Type': 'application/json', 'X-MLA-Token': token };
  const session = '2026-04-04_limits';
  const q = encodeURIComponent(session);

  // Two bytes per character, so a byte cap lands mid-character unless something prevents it. Emoji are
  // four bytes and a surrogate pair in UTF-16, which is what a code-unit slice can split.
  const line = (i) => `Zażółć gęślą jaźń ${i} - ąćęłńóśźż ĄĆĘŁŃÓŚŹŻ 🔵🟢🔴\n`;
  let sent = 0;
  for (let i = 0; sent < CAP * 2.5; i++) {
    const l = line(i);
    await fetch(`${base}/append`, { method: 'POST', headers: auth, body: JSON.stringify({ session, line: l }) });
    sent += Buffer.byteLength(l);
  }
  await sleep(800);
  check('the fixture really is bigger than the cap', sent > CAP * 2, `${sent} bytes`);

  // --- the wake channel -----------------------------------------------------------------------------
  const pollUrl = `${base}/poll?session=${q}&consumer=limits&backlog=1`;
  const one = await (await fetch(pollUrl, { headers: auth })).json();
  check('a capped read reports that there is more waiting', one.truncated === true, JSON.stringify({ truncated: one.truncated }));
  check('and stays within the byte cap', Buffer.byteLength(one.batch) <= CAP, `${Buffer.byteLength(one.batch)} > ${CAP}`);
  check('the batch has no replacement character, so no character was cut in half',
    !one.batch.includes('�'), JSON.stringify(one.batch.slice(-40)));
  check('a capped batch ends on a line boundary', one.batch.endsWith('\n'), JSON.stringify(one.batch.slice(-40)));

  const two = await (await fetch(pollUrl, { headers: auth })).json();
  check('the next read continues cleanly rather than starting mid-character', !two.batch.includes('�'), JSON.stringify(two.batch.slice(0, 40)));
  check('and it starts exactly where the last one stopped', two.batch.startsWith('Zażółć'), JSON.stringify(two.batch.slice(0, 20)));

  // Nothing may be lost across the cap: the two reads plus whatever is left must equal the whole channel.
  let all = one.batch + two.batch;
  for (let i = 0; i < 10; i++) {
    const more = await (await fetch(pollUrl, { headers: auth })).json();
    if (!more.batch) break;
    all += more.batch;
  }
  const onDisk = readFileSync(path.join(dir, `${session}.wake`), 'utf8');
  check('reading in capped chunks loses nothing', all === onDisk, `read ${all.length} of ${onDisk.length} chars`);

  // The wake loop has to be told it only got part of what was waiting, or the assistant reasons from a
  // batch that stops mid-conversation without knowing it.
  const text = await (await fetch(`${base}/poll?session=${q}&consumer=limits-text&format=text&backlog=1`, { headers: auth })).text();
  check('the text format says when it truncated', /truncated: \d+ more bytes waiting/.test(text), JSON.stringify(text.slice(0, 120)));

  // --- /transcript ----------------------------------------------------------------------------------
  const tr = await (await fetch(`${base}/transcript?session=${q}&tail=2000`, { headers: auth })).json();
  check('a truncated transcript says so', tr.truncated === true, JSON.stringify({ truncated: tr.truncated }));
  check('and respects the byte cap, not a code-unit count', Buffer.byteLength(tr.text) <= CAP, `${Buffer.byteLength(tr.text)} > ${CAP}`);
  check('with no lone surrogate at the cut', tr.text.isWellFormed(), JSON.stringify(tr.text.slice(0, 20)));
  check('no replacement character either', !tr.text.includes('�'));
  check('`lines` counts what came back, not what was asked for',
    tr.lines === tr.text.split('\n').filter((l) => l !== '').length, `${tr.lines} vs ${tr.text.split('\n').filter((l) => l !== '').length}`);
  check('`totalLines` still reports the whole meeting', tr.totalLines > tr.lines, `${tr.totalLines} vs ${tr.lines}`);
  check('truncation drops from the front, keeping the most recent exchange',
    tr.text.trimEnd().endsWith('🔵🟢🔴'), JSON.stringify(tr.text.slice(-30)));

  const small = await (await fetch(`${base}/transcript?session=${q}&tail=3`, { headers: auth })).json();
  check('an untruncated transcript says so too', small.truncated === false && small.lines === 3, JSON.stringify({ t: small.truncated, l: small.lines }));

  // --- /sessions counts lines without a trailing newline ---------------------------------------------
  const info = await (await fetch(`${base}/sessions?session=${q}`, { headers: auth })).json();
  const actual = readFileSync(path.join(dir, `${session}.txt`), 'utf8').split('\n').filter((l) => l !== '').length;
  check('the session line count matches the file', info.lines === actual, `${info.lines} vs ${actual}`);

  check('the server logged no errors through any of it', !/Error|error:/.test(err), err.slice(0, 300));
} catch (e) {
  check('the suite ran to completion', false, String((e && e.stack) || e));
} finally {
  if (server) server.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);

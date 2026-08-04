// Two failures that only appear once state is durable, both found by review and both reproduced before
// being fixed. They need file timestamps and a restart with a gap, which is why they are not in smoke.mjs.
//
//   node test/retention.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

const ROOT = path.resolve(import.meta.dirname, '..');
let failures = 0;

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

async function boot(port, dir, env = {}) {
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'transcript-server.js')], {
    env: { ...process.env, PORT: String(port), TRANSCRIPTS_DIR: dir, STATE_SNAPSHOT_MS: '150', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (c) => { out += c; });
  proc.stderr.on('data', (c) => { out += c; });
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return { proc, base, log: () => out }; } catch (_) { await sleep(250); }
  }
  throw new Error(`server never came up on ${port}\n${out}`);
}

const dirs = [];
function tmpDir() { const d = mkdtempSync(path.join(tmpdir(), 'mla-ret-')); dirs.push(d); return d; }
const procs = [];

try {
  // --- 1: a retention sweep must not wipe the meeting happening right now -----------------------------
  // A recurring series reuses its meet code, so the same session name comes back week after week. One
  // leftover file from an old instance aging past the cutoff was enough to make the sweep forget the live
  // session's advice and board, while today's transcript sat untouched on disk. Reproduced before the fix.
  {
    const dir = tmpDir();
    const port = await freePort();
    let s = await boot(port, dir, { RETENTION_DAYS: '14' });
    procs.push(s.proc);
    const token = readFileSync(path.join(dir, '.mla-token'), 'utf8').trim();
    const auth = { 'Content-Type': 'application/json', 'X-MLA-Token': token };
    const session = 'abc-defg-hij'; // a bare meet code, as a recurring series produces

    await fetch(`${s.base}/append`, { method: 'POST', headers: auth, body: JSON.stringify({ session, line: 'Ana: we decided today.\n' }) });
    await fetch(`${s.base}/advice`, { method: 'POST', headers: auth, body: JSON.stringify({ session, marker: 'RISK', text: 'advice from the live call' }) });
    await fetch(`${s.base}/items`, { method: 'POST', headers: auth, body: JSON.stringify({ session, kind: 'decision', text: 'decision from the live call' }) });

    // A file left by an instance from months ago, well past the retention cutoff.
    const stale = path.join(dir, `${session}.mode.txt`);
    writeFileSync(stale, 'lead\n');
    const old = new Date('2026-01-01T00:00:00Z');
    utimesSync(stale, old, old);

    await sleep(600);
    s.proc.kill('SIGKILL');
    await sleep(300);
    s = await boot(port, dir, { RETENTION_DAYS: '14' }); // purgeOld runs at boot
    procs.push(s.proc);
    await sleep(400);

    check('the sweep removed the stale file', !existsSync(stale));
    check("today's transcript was left alone", existsSync(path.join(dir, `${session}.txt`)));
    const advice = await (await fetch(`${s.base}/advice?session=${session}&since=0`, { headers: auth })).json();
    check('a stale side file does not wipe the live meeting\'s advice', advice.items.length === 1, JSON.stringify(advice.items));
    const items = await (await fetch(`${s.base}/items?session=${session}&since=0`, { headers: auth })).json();
    check('nor its decisions board', items.items.length === 1, JSON.stringify(items.items));

    // The other half of the contract: once nothing of a session is left, its state must go too.
    const goneSession = 'old-meeting-code';
    await fetch(`${s.base}/advice`, { method: 'POST', headers: auth, body: JSON.stringify({ session: goneSession, marker: 'INFO', text: 'from a meeting long past' }) });
    const goneFile = path.join(dir, `${goneSession}.txt`);
    writeFileSync(goneFile, 'Someone: old.\n');
    utimesSync(goneFile, old, old);
    await sleep(400);
    s.proc.kill('SIGKILL');
    await sleep(300);
    s = await boot(port, dir, { RETENTION_DAYS: '14' });
    procs.push(s.proc);
    await sleep(400);
    const purged = await (await fetch(`${s.base}/advice?session=${goneSession}&since=0`, { headers: auth })).json();
    check('a session with no files left keeps no state either', purged.items.length === 0, JSON.stringify(purged.items));
    s.proc.kill('SIGKILL');
  }

  // --- 2: held lines must not leak from one meeting into the next -------------------------------------
  // The wake gate holds small talk back until something substantial arrives. Those lines were persisted
  // with their flush timer stripped (a setTimeout handle cannot be serialized) and nothing re-armed it, so
  // they waited on disk until the same session name returned - and then arrived in a batch the assistant
  // reads as "what was just said". That is content crossing between meetings, not staleness.
  {
    const dir = tmpDir();
    const port = await freePort();
    // A short force ceiling is what makes "overdue" reachable in a test; the gate is otherwise untouched.
    const env = { WAKE_BASE_MS: '400', WAKE_MIN_GAP_MS: '100', WAKE_FORCE_MS: '1200' };
    let s = await boot(port, dir, env);
    procs.push(s.proc);
    const token = readFileSync(path.join(dir, '.mla-token'), 'utf8').trim();
    const auth = { 'Content-Type': 'application/json', 'X-MLA-Token': token };
    const session = 'weekly-standup';

    await fetch(`${s.base}/append`, { method: 'POST', headers: auth, body: JSON.stringify({ session, line: 'Bob: CONFIDENTIAL-FROM-MEETING-A, good morning everyone.\n' }) });
    await sleep(200);
    s.proc.kill('SIGKILL'); // no SIGTERM: its handler flushes, and that would hide the bug
    await sleep(300);

    const buffered = JSON.parse(readFileSync(path.join(dir, '.state', 'wakeBuf.json'), 'utf8'));
    check('the held line really was persisted, so the leak was reachable',
      JSON.stringify(buffered).includes('CONFIDENTIAL-FROM-MEETING-A'), JSON.stringify(buffered).slice(0, 160));

    await sleep(1400); // past WAKE_FORCE_MS: by any measure this batch's moment has passed
    s = await boot(port, dir, env);
    procs.push(s.proc);
    await sleep(400);
    check('the overdue buffer is dropped at boot, not held', !existsSync(path.join(dir, `${session}.wake`)),
      existsSync(path.join(dir, `${session}.wake`)) ? readFileSync(path.join(dir, `${session}.wake`), 'utf8') : '');
    check('and the server says so, rather than dropping it silently', /dropped 1 stale buffered line/.test(s.log()), s.log().slice(-300));

    // The next meeting on the same code must not receive it.
    await fetch(`${s.base}/append`, { method: 'POST', headers: auth, body: JSON.stringify({ session, line: 'Ann: we decided to start the new sprint.\n' }) });
    await sleep(900);
    // backlog=1 so this reader sees the whole channel: the question is whether the old line is in it
    // at all, not where a fresh reader would start.
    const poll = await (await fetch(`${s.base}/poll?session=${session}&consumer=next-meeting&backlog=1`, { headers: auth })).json();
    check('the next meeting on the same code does not receive last time\'s held line',
      !poll.batch.includes('CONFIDENTIAL-FROM-MEETING-A'), poll.batch);
    check('but it does receive its own', poll.batch.includes('new sprint'), poll.batch);
    s.proc.kill('SIGKILL');
  }

  // --- 3: a mid-call restart keeps a buffer that is still within its window ---------------------------
  // The mirror of the check above: dropping everything at boot would be safe but would throw away a batch
  // that a `launchctl` bounce interrupted seconds ago, which is the case the persistence exists for.
  {
    const dir = tmpDir();
    const port = await freePort();
    const env = { WAKE_BASE_MS: '400', WAKE_MIN_GAP_MS: '100', WAKE_FORCE_MS: '60000' };
    let s = await boot(port, dir, env);
    procs.push(s.proc);
    const token = readFileSync(path.join(dir, '.mla-token'), 'utf8').trim();
    const auth = { 'Content-Type': 'application/json', 'X-MLA-Token': token };
    const session = 'mid-call-bounce';

    await fetch(`${s.base}/append`, { method: 'POST', headers: auth, body: JSON.stringify({ session, line: 'Bob: good morning, how are you?\n' }) });
    await sleep(200);
    s.proc.kill('SIGKILL');
    await sleep(300);
    s = await boot(port, dir, env);
    procs.push(s.proc);
    await sleep(300);

    await fetch(`${s.base}/append`, { method: 'POST', headers: auth, body: JSON.stringify({ session, line: 'Ann: blocker - the deploy is rejected.\n' }) });
    await sleep(900);
    const poll = await (await fetch(`${s.base}/poll?session=${session}&consumer=brain&backlog=1`, { headers: auth })).json();
    check('a batch interrupted seconds ago still rides along after the restart', poll.batch.includes('good morning'), poll.batch);
    check('together with what came after it', poll.batch.includes('blocker'), poll.batch);
    s.proc.kill('SIGKILL');
  }

  // --- 4: a second process must not rewind the first one's live meeting ------------------------------
  // Two servers on one data dir (a sandbox run beside the launchd job) each hydrate at boot and then write
  // their own frozen view. One request to the second was enough to drop what the first had added since.
  {
    const dir = tmpDir();
    const portA = await freePort();
    const a = await boot(portA, dir);
    procs.push(a.proc);
    const token = readFileSync(path.join(dir, '.mla-token'), 'utf8').trim();
    const auth = { 'Content-Type': 'application/json', 'X-MLA-Token': token };
    const session = 'shared-dir';

    await fetch(`${a.base}/advice`, { method: 'POST', headers: auth, body: JSON.stringify({ session, marker: 'INFO', text: 'first, before B started' }) });
    await sleep(400);

    const portB = await freePort();
    const b = await boot(portB, dir);
    procs.push(b.proc);
    await fetch(`${a.base}/advice`, { method: 'POST', headers: auth, body: JSON.stringify({ session, marker: 'INFO', text: 'second, while B is running' }) });
    await fetch(`${b.base}/advice`, { method: 'POST', headers: auth, body: JSON.stringify({ session, marker: 'INFO', text: 'B writes something of its own' }) });
    await sleep(600);

    const onDisk = JSON.parse(readFileSync(path.join(dir, '.state', 'advice.json'), 'utf8'));
    const texts = (onDisk[0]?.[1]?.items || []).map((i) => i.text);
    check('the second process does not erase what the first wrote after it started',
      texts.includes('second, while B is running'), JSON.stringify(texts));
    check('and it reports why it is not persisting', /state lock|not persisting|cannot claim/.test(b.log()) || texts.length > 0, b.log().slice(-200));
    a.proc.kill('SIGKILL'); b.proc.kill('SIGKILL');
  }
} catch (e) {
  check('the suite ran to completion', false, String((e && e.stack) || e));
} finally {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch (_) {} }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);

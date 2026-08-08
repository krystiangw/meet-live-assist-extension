// /health is the only unauthenticated route, and it probes for a virtual audio device by spawning ffmpeg.
//
//   node test/health-burst.mjs
//
// The cache was written inside the probe's callback and only on success, so on the common install - no
// BlackHole present - every request missed it. A measured burst of 50 unauthenticated requests spawned 50
// concurrent ffmpeg processes, from a route that needs no token.
//
// This points FFMPEG at a stub that records each invocation, fires a burst, and asserts the whole burst cost
// exactly one spawn: concurrent callers collapse onto a single in-flight probe, and the negative result is
// cached so the next burst costs none.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import path from 'node:path';
import net from 'node:net';

const ROOT = path.resolve(import.meta.dirname, '..');
const dir = mkdtempSync(path.join(tmpdir(), 'mla-burst-'));
let failures = 0;
let server;

const check = (n, ok, d = '') => { console.log(`${ok ? '  ok  ' : '  FAIL'} ${n}${ok || !d ? '' : ` - ${d}`}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

try {
  // The probe is macOS-only by design (it goes through ffmpeg's audiotoolbox device), so elsewhere there is
  // nothing to spawn and nothing to assert. Say so rather than passing vacuously.
  if (platform() !== 'darwin') {
    console.log('  skip  the device probe only runs on macOS - nothing to burst here');
    console.log('\nall checks passed');
    process.exit(0);
  }

  const bin = path.join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const spawnLog = path.join(dir, 'spawns.log');
  // A stub that records itself, takes a moment (so a burst genuinely overlaps), and fails - the failure is
  // the case that used to defeat the cache.
  writeFileSync(path.join(bin, 'ffmpeg'), `#!/bin/sh\necho spawn >> "${spawnLog}"\nsleep 1\nexit 1\n`);
  chmodSync(path.join(bin, 'ffmpeg'), 0o755);
  writeFileSync(spawnLog, '');

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(ROOT, 'server', 'transcript-server.js')], {
    env: { ...process.env, PORT: String(port), TRANSCRIPTS_DIR: dir, FFMPEG: path.join(bin, 'ffmpeg') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Readiness on /auth-check, NOT /health: /auth-check needs no token either but runs no probe, so /health
  // is still cold when the burst arrives. Probing readiness on /health warmed the cache and the burst then
  // measured nothing - an assertion that passes for the wrong reason is worse than one that fails.
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`${base}/auth-check`)).ok) break; } catch (_) { await sleep(150); }
  }
  writeFileSync(spawnLog, '');

  const BURST = 30;
  const results = await Promise.all(Array.from({ length: BURST }, () => fetch(`${base}/health`).then((r) => r.status).catch(() => 0)));
  check(`all ${BURST} unauthenticated requests are answered`, results.every((s) => s === 200), JSON.stringify([...new Set(results)]));

  await sleep(1500); // let any spawn that was going to happen record itself
  const spawns = (readFileSync(spawnLog, 'utf8').match(/spawn/g) || []).length;
  check('a burst of concurrent probes costs exactly one process', spawns === 1, `${spawns} spawns for ${BURST} requests`);

  writeFileSync(spawnLog, '');
  await Promise.all(Array.from({ length: 10 }, () => fetch(`${base}/health`).catch(() => {})));
  await sleep(400);
  const cached = (readFileSync(spawnLog, 'utf8').match(/spawn/g) || []).length;
  check('and the next burst costs none, because a negative result is cached too', cached === 0, `${cached} spawns`);
} catch (e) {
  check('the suite ran to completion', false, String((e && e.stack) || e));
} finally {
  if (server) {
    try { server.kill(); } catch (_) {}
    await new Promise((r) => { server.once('exit', r); setTimeout(r, 3000); });
  }
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);

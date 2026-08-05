'use strict';
/*
 * Session state that survives a restart. Zero dependencies.
 *
 * The server keeps advice, the decisions board, chat, the wake buffer and two dozen other things in
 * module-level Maps. That made a restart destructive: `launchctl` bouncing the job mid-call silently
 * dropped the meeting's advice history and the buffered wake batch, which is why the README told you
 * never to restart during a live call. This module removes that hazard.
 *
 * Drop-in by design: `store.map('advice')` returns a real Map, pre-loaded from disk, so the ~90 call
 * sites keep using get/set/has/delete unchanged.
 *
 * Why a periodic snapshot rather than write-through on set(): values are mutated in place. The advice
 * handler does `const a = advice.get(s); a.seq++; a.items.push(item)` and never calls set() again, so
 * a set()-only hook would persist the first line of a call and nothing after it. Snapshotting on a
 * timer catches in-place mutation without asking every call site to announce itself. The cost of that
 * choice, stated plainly: a hard kill loses up to SNAPSHOT_MS (2s) of the most recent state. A signal
 * we can catch flushes first, so only SIGKILL or a crash pays it.
 *
 * Not everything may be persisted, and that is the important part. Three lifetimes share these Maps:
 * a durable record (advice, the board), state that MUST die with the process (a user's consent to let
 * the agent drive their tab; a "stopped" flag), and request scratch (a captured DOM). Persisting the
 * second kind resurrects consent the user gave once, days later. Callers declare that with
 * `{ persist: false }`; see the declarations in transcript-server.js.
 */

const fs = require('fs');
const path = require('path');

const SNAPSHOT_MS = parseInt(process.env.STATE_SNAPSHOT_MS || '2000', 10);

function createStore({ dir, log = () => {}, migrateKey = null }) {
  const stateDir = path.join(dir, '.state');
  const registered = [];
  let timer = null;
  let closed = false;
  let owned = null; // path of the lock file, once this process holds it

  function fileFor(name) { return path.join(stateDir, `${name}.json`); }

  // A value may hold something JSON can't carry (wakeBuf keeps a setTimeout handle). Drop those keys
  // on the way out; on the way back in their absence is already the "no pending flush" case the
  // wake code checks for, so nothing needs to reconstruct them.
  // Top-level keys only - a handle nested inside an array or a sub-object is not found, and the write
  // then fails loudly through serialize()'s catch rather than silently omitting it.
  function strip(value, omit) {
    if (!omit || !omit.length || !value || typeof value !== 'object' || Array.isArray(value)) return value;
    const out = {};
    for (const k of Object.keys(value)) if (!omit.includes(k)) out[k] = value[k];
    return out;
  }

  // State written before a key format change would otherwise hydrate under keys nothing looks up again:
  // present on disk, invisible to every request, and never purged because the sweep does not know them
  // either. The caller supplies the mapping; entries that are already current are returned untouched.
  function migrate(entries, name) {
    if (!migrateKey) return entries;
    let changed = 0;
    const out = entries.map((e) => {
      const isPair = Array.isArray(e) && e.length === 2;
      const key = isPair ? e[0] : e;
      const next = migrateKey(key);
      if (next === key) return e;
      changed++;
      return isPair ? [next, e[1]] : next;
    });
    if (changed) log(`[state] ${name}: migrated ${changed} key(s) to the current format`);
    return out;
  }

  function hydrate(name) {
    try {
      const raw = fs.readFileSync(fileFor(name), 'utf8');
      const entries = JSON.parse(raw);
      if (Array.isArray(entries)) return migrate(entries, name);
      log(`[state] ${name}.json is not an array - ignoring it`);
    } catch (e) {
      // Absent is the normal first-boot case and says nothing. Present but unreadable means we are
      // about to silently start a meeting with no history, which the operator should hear about.
      if (e.code !== 'ENOENT') log(`[state] ${name}.json unreadable (${e.message}) - starting empty`);
    }
    return [];
  }

  // Only one process may write this directory. Two servers on the same TRANSCRIPTS_DIR (a sandbox run
  // beside the launchd job) each hydrate at boot and then snapshot their own frozen view, so the
  // second one silently rewinds the first one's live meeting. Losing the race means reading and
  // serving normally but never writing - degraded, not destructive.
  function claimLock() {
    if (owned) return true;
    const lock = path.join(stateDir, '.writer.lock');
    try {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      try {
        fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
        owned = lock;
        return true;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      const holder = parseInt(fs.readFileSync(lock, 'utf8').trim(), 10);
      if (holder === process.pid) { owned = lock; return true; }
      // signal 0 tests for existence without delivering anything.
      try { process.kill(holder, 0); } catch (_) {
        fs.writeFileSync(lock, String(process.pid), { mode: 0o600 });
        owned = lock;
        log(`[state] took over a stale lock from pid ${holder}`);
        return true;
      }
      return false;
    } catch (e) {
      log(`[state] cannot claim the state lock (${e.message}) - not persisting`);
      return false;
    }
  }

  function register(entry) {
    // Baseline is what we just loaded, not null. Otherwise the first tick writes an empty array for
    // every store the install has never used, and a fresh data dir grows 28 files of "[]".
    try { entry.lastWritten = entry.serialize(); } catch (_) {}
    registered.push(entry);
    if (!timer && entry.persist) {
      timer = setInterval(snapshot, SNAPSHOT_MS);
      if (timer.unref) timer.unref(); // never hold the process open on our account
    }
    return entry.collection;
  }

  // Map: entries as [key, value] pairs. Set: entries as bare values.
  function map(name, { omit = [], persist = true } = {}) {
    const collection = new Map(persist ? hydrate(name) : []);
    return register({
      name, collection, persist, lastWritten: null,
      serialize: () => JSON.stringify([...collection.entries()].map(([k, v]) => [k, strip(v, omit)])),
    });
  }

  function set(name, { persist = true } = {}) {
    const collection = new Set(persist ? hydrate(name) : []);
    return register({
      name, collection, persist, lastWritten: null,
      serialize: () => JSON.stringify([...collection.values()]),
    });
  }

  // Compare against what we last wrote instead of tracking dirty flags: in-place mutation can't be
  // observed, and the persisted stores are kilobytes, so serializing to check is cheaper than being
  // wrong. The big payloads (a captured DOM, a debugger dump) are not persisted at all, which is what
  // keeps this affordable on a 2-second tick.
  function snapshot() {
    if (closed) return 0;
    if (!claimLock()) return 0;
    let wrote = 0;
    for (const entry of registered) {
      if (!entry.persist) continue;
      let json;
      try { json = entry.serialize(); } catch (e) { log(`[state] ${entry.name} not serializable: ${e.message}`); continue; }
      if (json === entry.lastWritten) continue;
      try {
        // Temp name carries the pid: a shared one lets two writers interleave in the same file, and
        // rename then promotes truncated JSON that hydrates as empty on the next boot.
        const tmp = `${fileFor(entry.name)}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, json, { mode: 0o600 });
        fs.renameSync(tmp, fileFor(entry.name));
        entry.lastWritten = json;
        wrote++;
      } catch (e) { log(`[state] write failed for ${entry.name}: ${e.message}`); }
    }
    return wrote;
  }

  function forget(key) {
    for (const { collection } of registered) collection.delete(key);
    snapshot();
  }

  function close() {
    snapshot();
    closed = true;
    if (timer) { clearInterval(timer); timer = null; }
    if (owned) { try { fs.unlinkSync(owned); } catch (_) {} owned = null; }
  }

  return { map, set, snapshot, forget, close, stateDir };
}

module.exports = { createStore };

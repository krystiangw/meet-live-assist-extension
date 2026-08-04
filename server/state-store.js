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
 * timer catches in-place mutation without asking every call site to announce itself.
 */

const fs = require('fs');
const path = require('path');

const SNAPSHOT_MS = parseInt(process.env.STATE_SNAPSHOT_MS || '2000', 10);

function createStore({ dir, log = () => {} }) {
  const stateDir = path.join(dir, '.state');
  const registered = [];
  let timer = null;
  let closed = false;

  function fileFor(name) { return path.join(stateDir, `${name}.json`); }

  // A value may hold something JSON can't carry (wakeBuf keeps a setTimeout handle). Drop those keys
  // on the way out; on the way back in their absence is already the "no pending flush" case the
  // wake code checks for, so nothing needs to reconstruct them.
  function strip(value, omit) {
    if (!omit || !omit.length || !value || typeof value !== 'object' || Array.isArray(value)) return value;
    const out = {};
    for (const k of Object.keys(value)) if (!omit.includes(k)) out[k] = value[k];
    return out;
  }

  function hydrate(name) {
    try {
      const raw = fs.readFileSync(fileFor(name), 'utf8');
      const entries = JSON.parse(raw);
      if (Array.isArray(entries)) return entries;
    } catch (_) { /* absent or unreadable: start empty, never fail a boot over cached state */ }
    return [];
  }

  function register(entry) {
    // Baseline is what we just loaded, not null. Otherwise the first tick writes an empty array for
    // every store the install has never used, and a fresh data dir grows 28 files of "[]".
    try { entry.lastWritten = entry.serialize(); } catch (_) {}
    registered.push(entry);
    if (!timer) {
      timer = setInterval(snapshot, SNAPSHOT_MS);
      if (timer.unref) timer.unref(); // never hold the process open on our account
    }
    return entry.collection;
  }

  // Map: entries as [key, value] pairs. Set: entries as bare values.
  function map(name, { omit = [] } = {}) {
    const collection = new Map(hydrate(name));
    return register({
      name, collection, lastWritten: null,
      serialize: () => JSON.stringify([...collection.entries()].map(([k, v]) => [k, strip(v, omit)])),
    });
  }

  function set(name) {
    const collection = new Set(hydrate(name));
    return register({
      name, collection, lastWritten: null,
      serialize: () => JSON.stringify([...collection.values()]),
    });
  }

  // Compare against what we last wrote instead of tracking dirty flags: in-place mutation can't be
  // observed, and these files are kilobytes, so serializing to check is cheaper than being wrong.
  function snapshot() {
    if (closed) return;
    let wrote = 0;
    for (const entry of registered) {
      let json;
      try { json = entry.serialize(); } catch (e) { log(`[state] ${entry.name} not serializable: ${e.message}`); continue; }
      if (json === entry.lastWritten) continue;
      try {
        fs.mkdirSync(stateDir, { recursive: true });
        // Write to a temp file and rename: a crash mid-write must not leave truncated JSON that
        // would then hydrate as empty on the next boot.
        const tmp = `${fileFor(entry.name)}.tmp`;
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
  }

  return { map, set, snapshot, forget, close, stateDir };
}

module.exports = { createStore };

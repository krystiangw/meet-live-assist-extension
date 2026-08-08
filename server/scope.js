'use strict';
/*
 * Who a piece of state belongs to, and where it lives on disk.
 *
 * Everything the server keeps - advice, the board, chat, transcripts, snapshots - is keyed by
 * (user, session). Today there is exactly one user, and the single-user profile is deliberately
 * indistinguishable from what came before it: same file names, same directory, no extra path segment.
 * That is the point. The seam exists so a hosted profile can namespace, while an existing install needs
 * no migration and a running server can be swapped underneath it.
 *
 * Its own module because the rules are small, exact, and the failure modes are severe in both
 * directions: too strict and a meeting is unreachable, too loose and one user reads another's call.
 */

const fs = require('fs');
const path = require('path');

const LOCAL_USER = 'local';
// The pair travels as one string joined by a character no sanitised segment can contain, so no session
// name can be crafted to impersonate another user's.
//
// It is deliberately a character that is LEGAL in a filename. NUL is not, and that was the worst possible
// choice: a key that reached a path helper by mistake made the fs call throw, straight into one of the
// empty catch blocks this server uses to tolerate missing files - so `/clear` silently deleted nothing and
// `/snapshots` silently returned an empty list, both reporting success. With a path-legal separator the
// same mistake produces a visibly wrong FILE, which a listing assertion catches on the spot. The
// unforgeability comes from the sanitiser stripping everything outside [A-Za-z0-9._-], not from the
// separator being exotic.
const SEP = '~';

// Only allow safe, contained names. Anything else becomes a path component and could escape the data dir.
// The literal strings a broken caller sends after interpolating a variable that was never set. They are
// perfectly legal session names, which is the whole problem: the server created `undefined.txt`, that became
// the newest transcript, the assistant pinned it, and an hour of a real interview was recorded into a
// namespace the panel was not watching - with every request answering a healthy 200. The guard existed on
// /append only, so six other routes could still mint the same file; /context could create it outright.
// Catching them here means every route that already refuses a session-less request refuses these too.
const POISON_NAMES = /^(undefined|null|nan|none|nil|false|0)$/i;

function safeSession(name) {
  const raw = String(name || '').trim();
  if (POISON_NAMES.test(raw)) return NO_SESSION;
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  // Reject pure-dot names ('.', '..'): joined with a dir they would escape it - `/clear` on '..' would
  // recursively delete the whole data dir.
  if (!cleaned || /^\.+$/.test(cleaned)) return NO_SESSION;
  return cleaned;
}

// A caller that sends no session at all is always a bug, and it used to be an expensive one: every such
// request minted `meeting_<Date.now()>`, so three polls produced three different meetings, each returning
// a healthy-looking 200. That is the shape of the incident this repo keeps referring to - an hour of a
// real interview transcribed into one session while the assistant advised into another, with nothing
// anywhere reporting an error. One stable name instead, so the mistake is a single visible place rather
// than unbounded ghost meetings, and `isNoSession` lets a route answer 400 instead of pretending.
const NO_SESSION = '_nosession';
function isNoSession(key) { return partsOf(key).session === NO_SESSION; }
function safeUser(name) {
  const cleaned = String(name || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  if (!cleaned || /^\.+$/.test(cleaned)) return LOCAL_USER;
  return cleaned;
}

// The key every store and every path is derived from. Build it once, where the session name arrives, and
// pass it around; never re-sanitise it, or the separator is mangled and the key resolves elsewhere.
function keyOf(user, rawSession) { return `${safeUser(user)}${SEP}${safeSession(rawSession)}`; }

// Split a key back into its parts. A bare session name resolves to the local user, so a value that
// reached a helper without going through keyOf still works instead of throwing.
function partsOf(key) {
  const raw = String(key == null ? '' : key);
  const at = raw.indexOf(SEP);
  return at < 0 ? { user: LOCAL_USER, session: safeSession(raw) } : { user: raw.slice(0, at), session: raw.slice(at + 1) };
}

// The name a client knows a meeting by. Keys never cross the wire: a client that receives one hands it
// straight back on the next request, where it would be scoped a second time into a different meeting.
function nameOf(key) { return partsOf(key).session; }

function createScope({ dataDir, snapDir }) {
  // The single local user gets the data dir itself. That is what keeps an existing layout untouched;
  // anyone else gets a directory of their own, created on demand and owner-only.
  function dirForUser(user) {
    return user === LOCAL_USER ? dataDir : path.join(dataDir, safeUser(user));
  }
  // `create` is opt-in, and reads must not pass it: asking whether another user's meeting exists should
  // not bring their directory into being. Today `userOf` is a constant so this never fires at all, which
  // is exactly why it needs deciding now rather than when it starts firing.
  function pathFor(key, suffix, { create = false } = {}) {
    const { user, session } = partsOf(key);
    const dir = dirForUser(user);
    if (create && dir !== dataDir) { try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (_) {} }
    return path.join(dir, `${session}${suffix}`);
  }
  function snapDirFor(key) {
    const { user, session } = partsOf(key);
    return user === LOCAL_USER ? path.join(snapDir, session) : path.join(snapDir, safeUser(user), session);
  }
  return { dirForUser, pathFor, snapDirFor };
}

module.exports = { LOCAL_USER, SEP, NO_SESSION, safeSession, safeUser, keyOf, partsOf, nameOf, isNoSession, createScope };

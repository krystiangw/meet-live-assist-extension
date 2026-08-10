// Caption de-duplication, replayed against a Meet that behaves like the real one.
//
//   node test/captions.mjs
//
// The panel showed the same sentence on two and three lines at once, and every headless test passed while it
// did, because they all assumed the caption area is an append-only log. It is a WINDOW: old utterances scroll
// out of it, and the recogniser rewrites what it has already shown (capitals after a sentence break,
// punctuation). This replays both behaviours through the real functions - lifted out of the shipped source,
// not re-typed here - and checks two things: the transcript loses nothing and repeats nothing, and the panel
// ends with one line per utterance.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok || !detail ? '' : ` - ${detail}`}`);
  if (!ok) failures++;
};

// Take a function's source straight out of the extension. Re-typing it here would let the copy drift from
// the shipped code and pass while the product is broken.
function lift(file, ...names) {
  const src = readFileSync(path.join(ROOT, 'src', file), 'utf8');
  const out = [];
  for (const name of names) {
    const arrow = src.match(new RegExp(`^\\s*const ${name} = .*$`, 'm'));
    if (arrow) { out.push(arrow[0]); continue; }
    const at = src.indexOf(`function ${name}(`);
    if (at < 0) throw new Error(`${file}: no ${name}`);
    let i = src.indexOf('{', at), depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
    }
    out.push(src.slice(at, i + 1));
  }
  return out.join('\n');
}

const { unsentTail } = await import(
  'data:text/javascript,' + encodeURIComponent(lift('content.js', 'wordKey', 'unsentTail') + '\nexport { unsentTail };'));
const { sameUtterance } = await import(
  'data:text/javascript,' + encodeURIComponent(lift('sidepanel.js', 'normUtterance', 'sameUtterance') + '\nexport { sameUtterance };'));

// ---- a Meet that scrolls and rewrites -------------------------------------
const SPOKEN = [
  'dobra Jak się dzisiaj macie',
  'co u was słychać jak się dzieci Chowają',
  'chciałem zapytać o ten release bo termin się zbliża',
  'i czy zdążymy przed piątkiem',
];
const WINDOW = 2; // utterances Meet keeps on screen; older ones scroll out

// While a sentence is being spoken the recogniser shows it lowercase and unpunctuated; on commit it
// capitalises the first word and adds a full stop. Those two edits are what broke the character prefix.
const live = (u, words) => u.split(' ').slice(0, words).join(' ').toLowerCase();
const committed = (u) => u.charAt(0).toUpperCase() + u.slice(1) + '.';

const norm = (x) => x.toLowerCase().replace(/[^a-z0-9ąćęłńóśźż ]+/g, ' ').replace(/\s+/g, ' ').trim();

function replay(tail) {
  const tracker = { sent: '', text: '' };
  const msgs = [];
  const done = [];
  for (const utterance of SPOKEN) {
    const total = utterance.split(' ').length;
    for (let w = 1; w <= total; w++) {
      tracker.text = [...done.slice(-WINDOW), live(utterance, w)].join(' ').trim();
      const t = tail(tracker.sent, tracker.text);
      if (t) msgs.push({ kind: 'cap', text: t });
    }
    tracker.text = [...done.slice(-WINDOW), committed(utterance)].join(' ').trim();
    const delta = tail(tracker.sent, tracker.text);
    tracker.sent = tracker.text;
    if (delta) msgs.push({ kind: 'cap-final', text: delta });
    done.push(committed(utterance));
  }
  return msgs;
}

// The panel keeps one element per utterance and updates it in place while the text stays the same utterance.
function panelLines(msgs) {
  const lines = [];
  for (const m of msgs) {
    const prev = lines.length ? lines[lines.length - 1] : null;
    if (prev && sameUtterance(prev, m.text)) lines[lines.length - 1] = m.text;
    else lines.push(m.text);
  }
  return lines;
}

const msgs = replay(unsentTail);
const transcript = norm(msgs.filter((m) => m.kind === 'cap-final').map((m) => m.text).join(' '));
check('transcript is exactly what was said, once', transcript === norm(SPOKEN.join(' ')),
  `\n      got:  ${transcript}\n      want: ${norm(SPOKEN.join(' '))}`);

const lines = panelLines(msgs);
check('panel ends with one line per utterance', lines.length === SPOKEN.length,
  `${lines.length} lines for ${SPOKEN.length} utterances:\n      ${lines.join('\n      ')}`);
check('each panel line is its utterance', lines.every((l, i) => norm(l) === norm(SPOKEN[i])),
  `\n      ${lines.join('\n      ')}`);

// No four consecutive words appear twice inside one line - the shape the bug had on screen.
const repeats = lines.filter((l) => {
  const w = norm(l).split(' ');
  const seen = new Set();
  for (let i = 0; i + 4 <= w.length; i++) {
    const s = w.slice(i, i + 4).join(' ');
    if (seen.has(s)) return true;
    seen.add(s);
  }
  return false;
});
check('no line repeats itself', repeats.length === 0, repeats.join(' | '));

// Positive control: the logic this replaced has to fail this replay, or the replay proves nothing.
// It fails on CONTENT, not on line count - each line grows to hold the whole visible window, so the count
// can look right while every line carries the previous utterance again.
const oldTail = (sent, text) => (sent && text.startsWith(sent) ? text.slice(sent.length).trim() : text.trim());
const oldMsgs = replay(oldTail);
const oldOk = norm(oldMsgs.filter((m) => m.kind === 'cap-final').map((m) => m.text).join(' ')) === norm(SPOKEN.join(' '))
  && panelLines(oldMsgs).every((l, i) => norm(l) === norm(SPOKEN[i]));
check('the replay actually catches the old logic', !oldOk, 'old logic passes too - the test cannot fail');

console.log(failures ? `\n${failures} check(s) failed` : '\nall caption checks passed');
process.exit(failures ? 1 : 0);

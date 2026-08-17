#!/bin/zsh
# Daily watchdog: take a snapshot, then say something ONLY when it matters.
#
# The point is not another number every morning. It is that the two things worth knowing - somebody real
# showed up, or the measurement quietly stopped working - both look identical to a log nobody reads. So this
# writes every change to changes.log and raises a desktop notification only for signals that deserve one.
#
# Deliberately NOT a notification signal: clone counts. They have gone up every day since the repo was
# listed, with zero matching page views, which is mirrors and scanners rather than people.
export PATH="$HOME/.local/share/fnm/aliases/default/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
DIR="$HOME/.local/state/meet-live-assist"
mkdir -p "$DIR"

"$HOME/.local/bin/mla-stats" || {
  osascript -e 'display notification "mla-stats failed to run" with title "Meet Live Assist"' 2>/dev/null
  exit 1
}

node - "$DIR" <<'EOF'
const fs = require('fs');
const path = require('path');
const dir = process.argv[2];
const rows = fs.readFileSync(path.join(dir, 'stats.jsonl'), 'utf8')
  .split('\n').filter((l) => l.trim()).map(JSON.parse);
if (rows.length < 2) process.exit(0);
const now = rows[rows.length - 1];
const prev = rows[rows.length - 2];
const g = (o, ...ks) => ks.reduce((a, k) => (a == null ? a : a[k]), o);

// A source that returned nothing is not a source that returned zero. Both have bitten this project once.
const broken = [];
if (g(now, 'github', 'views14d') == null) broken.push('GitHub traffic');
if (g(now, 'site', 'pageviews7d') == null) broken.push('GoatCounter');
if (g(now, 'npm', 'lastWeek') == null) broken.push('npm');
if (g(now, 'store', 'status') == null) broken.push('Chrome Web Store update service');
const problems = [];
if (g(now, 'store', 'status') === 'NOT OK') problems.push('store listing is NOT serving - possible takedown');

const watch = [
  ['stars', ['github', 'stars'], true],
  ['forks', ['github', 'forks'], true],
  ['watchers', ['github', 'watchers'], true],
  ['repo visitors (14d)', ['github', 'views14d', 'unique'], true],
  ['npm downloads (24h)', ['npm', 'lastDay'], true],
  ['site pageviews (7d)', ['site', 'pageviews7d'], false],
  ['clones (14d)', ['github', 'clones14d', 'unique'], false],
  ['issues from other people', ['github', 'issuesFromOthers'], true],
  ['outside pull requests', ['github', 'prsFromOthers'], true],
  ['open issues', ['github', 'openIssues'], false],
  ['store status', ['store', 'status'], true],
  ['store version', ['store', 'version'], true],
  ['Glama tools indexed', ['glama', 'tools'], true],
  ['Glama score', ['glama', 'score'], true],
  ['MCP registry', ['listings', 'mcpRegistry'], true],
  ['awesome-mcp PR', ['listings', 'awesomeMcpPr'], true],
];
const changes = [];
const loud = [];
for (const [label, keys, notify] of watch) {
  const a = g(prev, ...keys), b = g(now, ...keys);
  if (a === b || a == null || b == null) continue;
  const line = `${label}: ${a} -> ${b}`;
  changes.push(line);
  if (notify) loud.push(line);
}

// The number and the author of a new issue say more than a count going up, so it is detected before the log
// is written rather than after.
const ni = g(now, 'github', 'newestIssue');
const freshIssue = ni && g(prev, 'github', 'newestIssue')?.n !== ni.n && ni.by !== 'krystiangw'
  ? `issue #${ni.n} from ${ni.by}: ${ni.title}` : null;
if (freshIssue) { changes.unshift(freshIssue); loud.unshift(freshIssue); }

if (changes.length || broken.length || problems.length) {
  const stamp = now.at;
  const body = [
    `== ${stamp}`,
    ...changes.map((c) => `   ${c}`),
    ...broken.map((b) => `   MEASUREMENT BROKEN: ${b} returned nothing`),
    ...problems.map((p) => `   PROBLEM: ${p}`),
  ].join('\n');
  fs.appendFileSync(path.join(dir, 'changes.log'), body + '\n');
}

// A star from the repo owner is not an audience. The first run of this watchdog fired on exactly that.
const outsideStars = () => {
  const r = require('child_process').spawnSync('gh',
    ['api', 'repos/krystiangw/meet-live-assist-extension/stargazers', '--jq', '.[].login'],
    { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.split('\n').filter((l) => l.trim() && l.trim() !== 'krystiangw').length;
};
const filtered = loud.filter((l) => {
  if (!l.startsWith('stars:')) return true;
  const n = outsideStars();
  return n === null || n > 0;
});

const alert = [...problems, ...filtered, ...broken.map((b) => `${b} returned nothing`)];
if (alert.length) {
  const msg = alert.join(' · ').replace(/"/g, "'").slice(0, 200);
  require('child_process').spawnSync('osascript', ['-e',
    `display notification "${msg}" with title "Meet Live Assist" sound name "Submarine"`]);
}
console.log(changes.length || broken.length || problems.length ? `zmiany:\n${changes.map((c) => '  ' + c).join('\n')}` : 'bez zmian');
if (broken.length) console.log('  POMIAR ZEPSUTY:', broken.join(', '));
if (problems.length) console.log('  PROBLEM:', problems.join(', '));
EOF

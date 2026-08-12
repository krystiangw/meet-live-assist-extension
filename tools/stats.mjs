// Who, if anyone, is looking at this thing.
//
//   node tools/stats.mjs            human-readable
//   node tools/stats.mjs --json     for a script
//
// Four sources, because no single one sees a whole visitor: GitHub knows who reached the repo, GoatCounter
// knows who reached the site, npm knows who ran the server, and the Chrome Web Store knows installs and has
// no API worth wiring up for an unlisted item.
//
// GoatCounter needs a token, and without one this stays blind to the landing page - the biggest hole, since
// the site is the only thing being advertised. Make one at
// https://meetliveassist.goatcounter.com/user/api and put it in ~/.config/meet-live-assist/goatcounter-token
// (or GOATCOUNTER_TOKEN in the environment).
//
// What is NOT measurable, and should not be quietly treated as zero: downloads of a GitHub release's
// *source* zip, which is the install path the site pushes hardest. GitHub counts uploaded assets, not
// generated archives. Traffic on /releases is the closest proxy and it is in the popular-paths list.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = 'krystiangw/meet-live-assist-extension';
const PKG = 'meet-live-assist-server';
const GC = 'meetliveassist';
const JSON_OUT = process.argv.includes('--json');

const gh = (p, jq) => {
  try {
    const args = ['api', p];
    if (jq) args.push('--jq', jq);
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (_) { return null; }
};
const getJSON = async (url, headers) => {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    return r.ok ? await r.json() : null;
  } catch (_) { return null; }
};

function goatToken() {
  if (process.env.GOATCOUNTER_TOKEN) return process.env.GOATCOUNTER_TOKEN.trim();
  const f = path.join(os.homedir(), '.config', 'meet-live-assist', 'goatcounter-token');
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : null;
}

const out = { at: new Date().toISOString().slice(0, 16).replace('T', ' ') };

// ---- GitHub -------------------------------------------------------------
const views = JSON.parse(gh(`repos/${REPO}/traffic/views`) || 'null');
const clones = JSON.parse(gh(`repos/${REPO}/traffic/clones`) || 'null');
const refs = JSON.parse(gh(`repos/${REPO}/traffic/popular/referrers`) || '[]');
const paths = JSON.parse(gh(`repos/${REPO}/traffic/popular/paths`) || '[]');
const repo = JSON.parse(gh(`repos/${REPO}`) || 'null');

const today = new Date().toISOString().slice(0, 10);
const dayOf = (series, d) => (series || []).find((x) => x.timestamp.slice(0, 10) === d);
out.github = {
  stars: repo?.stargazers_count ?? null,
  forks: repo?.forks_count ?? null,
  watchers: repo?.subscribers_count ?? null,
  views14d: views ? { total: views.count, unique: views.uniques } : null,
  viewsToday: views ? (dayOf(views.views, today)?.uniques ?? 0) : null,
  clones14d: clones ? { total: clones.count, unique: clones.uniques } : null,
  clonesToday: clones ? (dayOf(clones.clones, today)?.uniques ?? 0) : null,
  referrers: refs.slice(0, 5).map((r) => ({ from: r.referrer, unique: r.uniques })),
  paths: paths.slice(0, 5).map((p) => ({ path: p.path.replace(`/${REPO}`, '') || '/', unique: p.uniques })),
};

// ---- npm ----------------------------------------------------------------
const [day, week] = await Promise.all([
  getJSON(`https://api.npmjs.org/downloads/point/last-day/${PKG}`),
  getJSON(`https://api.npmjs.org/downloads/point/last-week/${PKG}`),
]);
out.npm = { lastDay: day?.downloads ?? null, lastWeek: week?.downloads ?? null };

// ---- GoatCounter --------------------------------------------------------
const token = goatToken();
if (!token) {
  out.site = { error: 'no token - the landing page is unmeasured. See the header of this file.' };
} else {
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const since = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const hits = await getJSON(`https://${GC}.goatcounter.com/api/v0/stats/hits?start=${since}`, h);
  const total = await getJSON(`https://${GC}.goatcounter.com/api/v0/stats/total?start=${since}`, h);
  out.site = hits
    ? {
        visitors7d: total?.total_unique ?? null,
        pageviews7d: total?.total ?? null,
        pages: (hits.hits || []).slice(0, 6).map((p) => ({ path: p.path, visitors: p.count_unique ?? p.count })),
      }
    : { error: 'token present but the API refused - check it is still valid' };
}

// ---- listings -----------------------------------------------------------
const reg = await getJSON(`https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.krystiangw/meet-live-assist`);
const pr = gh('repos/punkpeye/awesome-mcp-servers/pulls/12002', '.state + " " + (.merged_at // "")');
out.listings = {
  mcpRegistry: reg?.servers?.[0] ? 'active' : 'MISSING',
  awesomeMcpPr: pr || 'unknown',
};

if (JSON_OUT) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

const n = (v) => (v === null || v === undefined ? '?' : v);
console.log(`\n  Meet Live Assist - reach, ${out.at}\n`);
const g = out.github;
console.log(`  GitHub   ${n(g.stars)}★  ${n(g.forks)} forks  ${n(g.watchers)} watching`);
console.log(`           views  ${n(g.viewsToday)} unique today, ${n(g.views14d?.unique)} unique / ${n(g.views14d?.total)} total over 14d`);
console.log(`           clones ${n(g.clonesToday)} unique today, ${n(g.clones14d?.unique)} unique / ${n(g.clones14d?.total)} total over 14d`);
if (g.referrers.length) console.log(`           from   ${g.referrers.map((r) => `${r.from} (${r.unique})`).join(', ')}`);
if (g.paths.length) console.log(`           pages  ${g.paths.map((p) => `${p.path} (${p.unique})`).join(', ')}`);
console.log(`\n  npm      ${n(out.npm.lastDay)} downloads yesterday, ${n(out.npm.lastWeek)} over 7 days`);
if (out.site.error) console.log(`\n  Site     ${out.site.error}`);
else {
  console.log(`\n  Site     ${n(out.site.visitors7d)} visitors / ${n(out.site.pageviews7d)} pageviews over 7 days`);
  for (const p of out.site.pages) console.log(`           ${String(p.visitors).padStart(4)}  ${p.path}`);
}
console.log(`\n  Listings MCP registry: ${out.listings.mcpRegistry} · awesome-mcp PR #12002: ${out.listings.awesomeMcpPr}`);
console.log('\n  Not measurable: source-zip downloads from the release page, and Chrome Web Store installs');
console.log('  while the item is unlisted and under review. Neither is zero; both are unknown.\n');

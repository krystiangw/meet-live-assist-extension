// The store form needs a privacy policy at a URL that works, so PRIVACY.md is rendered into the site with the
// same shell as the other three pages.
//
//   node tools/privacy-page.mjs      (re-run after every edit to PRIVACY.md)
//
// docs/privacy.html is generated, not written: edit PRIVACY.md, then run this. It lived in a scratch
// directory for one afternoon, which meant the only copy of the page's shell was one cleanup away from gone.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE = 'https://krystiangw.github.io/meet-live-assist/';

const md = readFileSync(`${ROOT}/PRIVACY.md`, 'utf8');
let body = execFileSync('npx', ['--yes', 'marked', '--gfm'], { input: md, encoding: 'utf8', maxBuffer: 1 << 24 });

// Links to files in the code repo would 404 for anyone until that repo is public; the ones that matter here
// are the pages next to this one.
body = body
  .replace(/href="MCP-CLIENTS\.md"/g, 'href="reference.html"')
  .replace(/href="README\.md"/g, 'href="./"')
  .replace(/href="STORE\.md"/g, 'href="./"');

// Off-site links open beside the page, same as everywhere else on the site.
body = body.replace(/<a href="(https?:\/\/[^"]+)"/g, (m, url) =>
  url.startsWith(BASE) ? m : `<a href="${url}" target="_blank" rel="noopener noreferrer"`);

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Meet Live Assist - privacy policy</title>
<meta name="description" content="What Meet Live Assist stores, where it stores it, what leaves your machine and what never does." />
<link rel="canonical" href="${BASE}privacy.html" />
<meta property="og:type" content="website" />
<meta property="og:url" content="${BASE}privacy.html" />
<meta property="og:title" content="Meet Live Assist - privacy policy" />
<meta property="og:description" content="What Meet Live Assist stores, where it stores it, what leaves your machine and what never does." />
<meta property="og:image" content="${BASE}media/og-card.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="icon" href="icon.svg" type="image/svg+xml" />
<link rel="icon" href="icon48.png" sizes="48x48" />
<link rel="stylesheet" href="style.css" />
</head>
<body>
<nav class="top">
  <div class="inner">
    <a class="brand" href="./">Meet Live Assist</a>
    <a href="./">Overview</a>
    <a href="reference.html">How it works</a>
    <a href="faq.html">Q&amp;A</a>
    <a href="https://github.com/krystiangw/meet-live-assist-extension" target="_blank" rel="noopener noreferrer">GitHub</a>
  </div>
</nav>

<div class="wrap prose">
${body.trim()}
</div>

<footer>
  Meet Live Assist · a live meeting assistant you run yourself · your files stay on your disk
  <br />
  by <a href="https://krystiangw.github.io/krystiangw/" target="_blank" rel="noopener noreferrer">Krystian Gwizdała</a>
  <br />
  <span class="fine">Meet Live Assist is an independent project. It is not affiliated with, endorsed by or sponsored by Google or Zoom; "Google Meet" and "Zoom" are their owners' trademarks and are used here only to say which products this works with.</span>
</footer>

<script data-goatcounter="https://meetliveassist.goatcounter.com/count"
        async src="https://gc.zgo.at/count.js"></script>
</body>
</html>
`;

writeFileSync(`${ROOT}/docs/privacy.html`, html);
console.log('docs/privacy.html', html.length, 'bytes');

// Runs every suite and reports all of them.
//
//   node test/run-all.mjs        (this is `npm test`)
//
// It used to be `a && b && c && ...`, which stops at the first failure. One flake in the middle silently
// took two entire suites - about 40% of the checks - out of the run, and the output named a single cause
// when there might have been several. A test command that can hide coverage is worse than a slow one.
import { spawn } from 'node:child_process';
import path from 'node:path';

const SUITES = ['scope', 'smoke', 'panel', 'mcp', 'limits', 'retention', 'wake-failure'];
const here = import.meta.dirname;

const run = (name) => new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(here, `${name}.mjs`)], { stdio: 'inherit' });
  p.on('close', (code) => resolve({ name, code: code ?? 1 }));
  p.on('error', () => resolve({ name, code: 1 }));
});

const results = [];
for (const name of SUITES) {
  console.log(`\n=== ${name} ===`);
  results.push(await run(name));
}

const failed = results.filter((r) => r.code !== 0);
console.log('\n' + '-'.repeat(52));
for (const r of results) console.log(`  ${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.name}`);
console.log(failed.length ? `\n${failed.length} suite(s) failed: ${failed.map((r) => r.name).join(', ')}`
  : `\nall ${results.length} suites passed`);
process.exit(failed.length ? 1 : 0);

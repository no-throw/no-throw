// report.mjs — THROWAWAY spike (no-throw ticket #15).
//
// Builds the CONSUMER's own ts.Program (the producer is only a compiled dep in
// its node_modules) and enforces every @nothrow seed in app.ts under three
// configurations:
//
//   A. manifest on            — the #15 mechanism as designed
//   B. async flag ignored     — counterfactual: proves the #12 flag is load-bearing
//   C. no manifest at all     — control: proves the manifest carries the color,
//                               and that its absence degrades SAFELY (fail-safe)
//
// Self-checking: every run has an expected verdict per function; any mismatch
// fails the process.

import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { isMarked, collectEscapes } from '../color-engine.mjs';
import { makeManifestResolver } from './manifest-reader.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const consumerDir = resolve(here, 'consumer');

const B = '\x1b[1m', D = '\x1b[2m', R = '\x1b[0m', GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m';

const parsed = ts.getParsedCommandLineOfConfigFile(join(consumerDir, 'tsconfig.json'), {}, ts.sys);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();

// ── sanity: the dependency is present, resolved, and genuinely opaque ───────
const depFile = program
  .getSourceFiles()
  .find((sf) => sf.fileName.includes('@spike/mathkit') || sf.fileName.includes('@spike\\mathkit'));
if (!depFile) {
  console.error(`${RED}dependency did not resolve — run emit + install first (pnpm boundary)${R}`);
  process.exit(1);
}
console.log(`\n${B}[3/3] consumer report — separate program, compiled dep${R}\n`);
console.log(`  dep source in program: ${D}${depFile.fileName.split('node_modules/').pop()}${R}`);
console.log(
  `  ${depFile.isDeclarationFile ? GREEN + 'opaque: .d.ts only' : RED + 'NOT opaque'}${R}` +
    `${depFile.text.includes('@nothrow') ? `, ${RED}but @nothrow leaked in${R}` : `, ${GREEN}no @nothrow in it${R}`}` +
    `${/\basync\b/.test(depFile.text) ? `, ${RED}async leaked in${R}` : `, ${GREEN}no async keyword in it${R}`}\n`,
);

// ── the three runs ──────────────────────────────────────────────────────────
const RUNS = [
  {
    key: 'A',
    label: 'manifest on',
    opts: () => ({ resolveOpaque: makeManifestResolver() }),
    expect: {
      handleConfig: 'PASS',
      handleStrict: 'FAIL',
      handleStrictBridged: 'PASS',
      greet: 'PASS',
      flakyAwaitBare: 'FAIL',
      flakyAwaitBridged: 'PASS',
      fireAndForget: 'PASS',
      fakeBridge: 'FAIL',
      floatEscape: 'FAIL',
      trustBadMark: 'FAIL',
    },
  },
  {
    key: 'B',
    label: 'async flag ignored (counterfactual)',
    opts: () => ({ resolveOpaque: makeManifestResolver(), ignoreAsyncFlag: true }),
    expect: {
      handleConfig: 'PASS',
      handleStrict: 'FAIL',
      handleStrictBridged: 'PASS',
      greet: 'PASS',
      flakyAwaitBare: 'FAIL',
      flakyAwaitBridged: 'PASS',
      fireAndForget: 'FAIL', // ← the flip: without the flag the .catch bridge is unsound
      fakeBridge: 'FAIL',
      floatEscape: 'FAIL',
      trustBadMark: 'FAIL',
    },
  },
  {
    key: 'C',
    label: 'no manifest (control)',
    opts: () => ({}),
    expect: {
      handleConfig: 'FAIL', // ← color no longer crosses the boundary…
      handleStrict: 'FAIL',
      handleStrictBridged: 'PASS',
      greet: 'FAIL', // ← …everything floors to throwing: fail-SAFE, not unsound
      flakyAwaitBare: 'FAIL',
      flakyAwaitBridged: 'PASS',
      fireAndForget: 'FAIL',
      fakeBridge: 'FAIL',
      floatEscape: 'FAIL',
      trustBadMark: 'FAIL',
    },
  },
];

const appFile = program.getSourceFiles().find((sf) => sf.fileName.endsWith('app.ts'));
const seeds = appFile.statements.filter((s) => ts.isFunctionDeclaration(s) && s.name && isMarked(s));

let mismatches = 0;
const results = new Map(); // name → per-run { verdict, reasons }

for (const run of RUNS) {
  const memo = new Map();
  const opts = run.opts();
  for (const fn of seeds) {
    const escapes = collectEscapes(fn, checker, memo, new Set(), opts);
    const verdict = escapes.length === 0 ? 'PASS' : 'FAIL';
    const perFn = results.get(fn.name.text) ?? {};
    perFn[run.key] = {
      verdict,
      reasons: escapes.map((e) => (e.kind === 'throw' ? 'uncaught throw' : `${e.name}: ${e.reason}`)),
    };
    results.set(fn.name.text, perFn);
    if (run.expect[fn.name.text] !== verdict) mismatches++;
  }
}

// ── render ──────────────────────────────────────────────────────────────────
const cell = (run, name) => {
  const { verdict } = results.get(name)[run.key];
  const ok = RUNS.find((r) => r.key === run.key).expect[name] === verdict;
  const color = verdict === 'PASS' ? GREEN : YELLOW;
  return `${color}${verdict}${R}${ok ? D + '      ' + R : RED + ' ✗exp' + R}`;
};

console.log(`  ${''.padEnd(20)} ${B}A:manifest${R}  ${B}B:no-flag${R}   ${B}C:no-manifest${R}`);
for (const fn of seeds) {
  const name = fn.name.text;
  console.log(`  ${name.padEnd(20)} ${cell(RUNS[0], name)} ${cell(RUNS[1], name)} ${cell(RUNS[2], name)}`);
}

console.log(`\n  ${B}why (run A failures)${R}`);
for (const fn of seeds) {
  const { verdict, reasons } = results.get(fn.name.text).A;
  if (verdict === 'FAIL') console.log(`  ${fn.name.text.padEnd(20)} ${D}${reasons.join('; ')}${R}`);
}

const flip = results.get('fireAndForget');
console.log(
  `\n  ${B}the load-bearing bit:${R} fireAndForget is ${flip.A.verdict} with the manifest's async flag, ` +
    `${flip.B.verdict} without it ${D}(the .d.ts alone can never license the .catch bridge)${R}`,
);

if (mismatches > 0) {
  console.log(`\n${RED}${B}${mismatches} verdict(s) diverged from expectations${R}\n`);
  process.exit(1);
}
console.log(`\n${GREEN}${B}all verdicts across all three runs match expectations${R}\n`);

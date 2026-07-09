// report.mjs — THROWAWAY spike (no-throw ticket #6)
//
// The "surface the state" view. Builds a ts.Program over the fixtures and prints,
// for every named function, its resolved color and (for seeds) its enforcement
// verdict — so you can see the whole coloring at a glance, not just the failures.
// The ESLint rule and this runner share ONE engine (color-engine.mjs).

import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { isMarked, resolveColor, collectEscapes } from './color-engine.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(here, 'tsconfig.json');

const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, ts.sys);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
const memo = new Map();

const B = '\x1b[1m';
const D = '\x1b[2m';
const R = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';

console.log(`\n${B}no-throw spike — color report${R} ${D}(#4 hybrid + #5 @nothrow carrier)${R}\n`);

for (const sf of program.getSourceFiles()) {
  if (sf.isDeclarationFile || !parsed.fileNames.includes(sf.fileName)) continue;
  const rel = sf.fileName.split('/').slice(-2).join('/');
  console.log(`${B}${rel}${R}`);

  const fns = [];
  const walk = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) fns.push(node);
    ts.forEachChild(node, walk);
  };
  walk(sf);

  for (const fn of fns) {
    const name = fn.name.getText();
    const marked = isMarked(fn);
    const color = marked ? 'non-throwing' : resolveColor(fn, checker, memo);
    const origin = marked ? 'declared' : 'inferred';
    const colorLabel =
      color === 'non-throwing' ? `${GREEN}non-throwing${R}` : `${YELLOW}throwing${R}`;

    let verdict = `${D}—${R}`;
    if (marked) {
      const escapes = collectEscapes(fn, checker, memo);
      verdict =
        escapes.length === 0
          ? `${GREEN}PASS${R}`
          : `${RED}FAIL${R} ${D}(${escapes
              .map((e) => (e.kind === 'throw' ? 'uncaught throw' : `bare call ${e.name}`))
              .join(', ')})${R}`;
    }

    console.log(
      `  ${name.padEnd(16)} ${colorLabel.padEnd(28)} ${D}${origin.padEnd(9)}${R} ${verdict}`,
    );
  }
  console.log('');
}

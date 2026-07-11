// emit-manifest.mjs — THROWAWAY spike (no-throw ticket #15).
//
// The producer's build step, the thing #5 calls "lowering the verified marks":
//   1. compile src → dist  (.d.ts + .js, comments stripped — the opaque surface)
//   2. VERIFY every @nothrow mark with the engine; only enforcement-passing
//      functions are lowered into the manifest (trust-by-construction, #5)
//   3. record the async witness (#12): `async` is erased from the .d.ts, so
//      sync-safety must ride the manifest — including for THROWING async
//      exports (the `fetch` shape), or the consumer can never .catch-bridge them

import ts from 'typescript';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { isMarked, collectEscapes } from '../color-engine.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const producerDir = resolve(here, 'producer');

const B = '\x1b[1m', D = '\x1b[2m', R = '\x1b[0m', GREEN = '\x1b[32m', RED = '\x1b[31m';

console.log(`\n${B}[1/3] producer build — verify marks, emit dist + nothrow.json${R}\n`);

const parsed = ts.getParsedCommandLineOfConfigFile(join(producerDir, 'tsconfig.json'), {}, ts.sys);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
program.emit(); // dist/: declaration:true + removeComments:true

const memo = new Map();
const manifestExports = {};

for (const sf of program.getSourceFiles()) {
  if (sf.isDeclarationFile || !parsed.fileNames.includes(sf.fileName)) continue;
  for (const stmt of sf.statements) {
    if (!ts.isFunctionDeclaration(stmt) || !stmt.name) continue;
    if (!stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;

    const name = stmt.name.text;
    const isAsync = !!stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);

    if (isMarked(stmt)) {
      const escapes = collectEscapes(stmt, checker, memo);
      if (escapes.length > 0) {
        console.log(
          `  ${RED}refused${R}  ${name.padEnd(16)} ${D}mark is a lie (${escapes.length} escape(s)) — NOT lowered; consumers floor it${R}`,
        );
        continue;
      }
      manifestExports[name] = { color: 'non-throwing', async: isAsync };
      console.log(`  ${GREEN}lowered${R}  ${name.padEnd(16)} ${D}non-throwing, async: ${isAsync}${R}`);
    } else if (isAsync) {
      // not non-throwing, but the async keyword is a compiler-checked fact:
      // carry the sync-safety witness so the .catch bridge stays available
      manifestExports[name] = { color: 'throwing', async: true };
      console.log(`  ${GREEN}lowered${R}  ${name.padEnd(16)} ${D}throwing, async: true (sync-safe witness only)${R}`);
    } else {
      console.log(`  ${D}skipped  ${name.padEnd(16)} unmarked & sync — absence = the throwing floor${R}`);
    }
  }
}

const manifest = { version: 0, exports: manifestExports };
writeFileSync(join(producerDir, 'nothrow.json'), JSON.stringify(manifest, null, 2) + '\n');

// evidence that the boundary really is opaque
const dts = readFileSync(join(producerDir, 'dist', 'index.d.ts'), 'utf8');
console.log(`\n  ${B}dist/index.d.ts${R} ${D}(what the consumer's program actually sees)${R}`);
for (const line of dts.trimEnd().split('\n')) console.log(`    ${D}${line}${R}`);
console.log(
  `\n  ${dts.includes('@nothrow') ? RED + 'PROBLEM: @nothrow survived into the .d.ts' : GREEN + 'stripped: no @nothrow tag in the .d.ts'}${R}` +
    `\n  ${dts.includes('async') ? RED + 'PROBLEM: async survived into the .d.ts' : GREEN + 'erased: no async keyword in the .d.ts'}${R}\n`,
);

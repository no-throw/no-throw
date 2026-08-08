/**
 * Dogfooding `@nothrow/core` measures a project with three marks in it, so it
 * says nothing about what a mark costs. This generates the opposite corpus — a
 * project that is nothing but marks — so the per-site side of the engine can be
 * priced against the per-program side.
 *
 * Each marked seed reaches `depth` unmarked callees, so the fixpoint has a real
 * graph to walk rather than a wall of leaves.
 *
 * Usage: node marked-corpus.mjs [files] [marksPerFile] [depth]
 * Then:  node request-cost.mjs fixtures/marked-<files>x<marks>x<depth>/tsconfig.json
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const files = Number(process.argv[2] ?? 20);
const marksPerFile = Number(process.argv[3] ?? 10);
const depth = Number(process.argv[4] ?? 5);

const root = path.resolve(`fixtures/marked-${files}x${marksPerFile}x${depth}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(path.join(root, "src"), { recursive: true });

writeFileSync(
  path.join(root, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
      },
      include: ["src"],
    },
    null,
    2,
  ),
);

// A package home, because the carrier chain's first question is which package
// is asking — a corpus with no `package.json` would skip the surface walk and
// flatter the numbers.
writeFileSync(
  path.join(root, "package.json"),
  JSON.stringify(
    { name: "marked-corpus", version: "0.0.0", type: "module", exports: { ".": "./src/index.js" } },
    null,
    2,
  ),
);

/** A chain of `depth` unmarked helpers, all clean, for inference to walk. */
function helpers(prefix) {
  let src = `function ${prefix}_h0(x: string): number { return x.length; }\n`;
  for (let i = 1; i < depth; i++) {
    src += `function ${prefix}_h${i}(x: string): number { return ${prefix}_h${i - 1}(x) + 1; }\n`;
  }
  return src;
}

const names = [];
for (let f = 0; f < files; f++) {
  const prefix = `f${f}`;
  let src = helpers(prefix);
  for (let m = 0; m < marksPerFile; m++) {
    // A property read, a coercion and an iteration alongside the call, so the
    // hidden-transfer and consumption paths are exercised too.
    src +=
      `/** @nothrow */\n` +
      `export function ${prefix}_m${m}(x: string, xs: readonly number[]): string {\n` +
      `  let total = ${prefix}_h${depth - 1}(x) + xs.length;\n` +
      `  for (const n of xs) total += n;\n` +
      `  return \`\${total}\`;\n` +
      `}\n`;
    names.push(`${prefix}_m${m}`);
  }
  writeFileSync(path.join(root, "src", `${prefix}.ts`), src);
}

writeFileSync(
  path.join(root, "src", "index.ts"),
  Array.from({ length: files }, (_, f) => `export * from "./f${f}.js";\n`).join(""),
);

console.log(
  `${root}\n  ${files} files, ${files * marksPerFile} marks, chain depth ${depth}`,
);

/**
 * Chase the deep-chain anomaly reported in
 * research/linter-backends-ts7-oxlint-native.md: 500 functions in a transitive
 * call chain loaded in 35.7 s and showed 51 ms/request, against 154 ms and
 * 0.20 ms/request for 500 independent functions.
 *
 * The original fixture was not preserved, so this rebuilds the shape under
 * variants that separate the candidate causes:
 *
 *   independent-1file  — the known-good baseline
 *   chain-1file        — transitive chain, every signature annotated
 *   chain-1file-inferred — same chain with inferred return types
 *   independent-nfiles — one function per file, no chain
 *   chain-nfiles       — one function per file, transitive chain
 *
 * If the anomaly follows "chain", it is an inference pathology. If it follows
 * "nfiles", it is file materialization and has nothing to do with our fixpoint.
 */
import { API } from "@typescript/native-preview/unstable/sync";
import { SyntaxKind } from "@typescript/native-preview/unstable/ast";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const slash = (p) => p.split(path.sep).join("/");

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    strict: true,
    module: "NodeNext",
    moduleResolution: "NodeNext",
  },
  include: ["src"],
});

/** Every fixture exposes the same shape: an entry file plus the call sites. */
function write(root, files) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "tsconfig.json"), TSCONFIG);
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(path.join(root, "src", name), text);
  }
}

const ret = (annotated) => (annotated ? ": number" : "");

function independentOneFile(root, n) {
  let src = "declare function helper(x: string): number;\n";
  for (let i = 0; i < n; i++) {
    src += `export function f${i}(x: string): number { return helper(x); }\n`;
  }
  write(root, { "index.ts": src });
  return "index.ts";
}

function chainOneFile(root, n, annotated) {
  // f0 is the leaf; f_{i} calls f_{i-1}. Declared bottom-up so every callee is
  // already in scope, which is what an inferred-return chain needs to resolve
  // without circularity.
  let src = `export function f0(x: string)${ret(annotated)} { return x.length; }\n`;
  for (let i = 1; i < n; i++) {
    src += `export function f${i}(x: string)${ret(annotated)} { return f${i - 1}(x); }\n`;
  }
  write(root, { "index.ts": src });
  return "index.ts";
}

function independentManyFiles(root, n) {
  const files = {};
  for (let i = 0; i < n; i++) {
    files[`f${i}.ts`] = `export function f${i}(x: string): number { return x.length; }\n`;
  }
  let entry = "";
  for (let i = 0; i < n; i++) entry += `import { f${i} } from "./f${i}.js";\n`;
  entry += `export function use(x: string): number { return ${Array.from({ length: n }, (_, i) => `f${i}(x)`).join(" + ")}; }\n`;
  files["index.ts"] = entry;
  write(root, files);
  return "index.ts";
}

function chainManyFiles(root, n, annotated) {
  const files = {};
  files["f0.ts"] = `export function f0(x: string)${ret(annotated)} { return x.length; }\n`;
  for (let i = 1; i < n; i++) {
    files[`f${i}.ts`] =
      `import { f${i - 1} } from "./f${i - 1}.js";\n` +
      `export function f${i}(x: string)${ret(annotated)} { return f${i - 1}(x); }\n`;
  }
  files["index.ts"] =
    `import { f${n - 1} } from "./f${n - 1}.js";\n` +
    `export function use(x: string): number { return f${n - 1}(x); }\n`;
  write(root, files);
  return "index.ts";
}

function measure(label, root, entry) {
  const cfg = slash(path.join(root, "tsconfig.json"));
  const file = slash(path.join(root, "src", entry));

  const api = new API({ cwd: root, collectTiming: true });

  const t0 = performance.now();
  const snapshot = api.updateSnapshot({ openProjects: [cfg] });
  const project = snapshot.getProject(cfg) ?? snapshot.getProjects()[0];
  const t1 = performance.now();
  const sf = project.program.getSourceFile(file);
  const t2 = performance.now();
  const load = api.getTimingInfo().totals;

  api.resetTimingInfo();
  const calls = [];
  (function walk(node) {
    if (node.kind === SyntaxKind.CallExpression) calls.push(node);
    node.forEachChild(walk);
  })(sf);
  const t3 = performance.now();
  const walk = api.getTimingInfo().totals;

  const checker = project.checker;
  const callees = calls.map((c) => c.expression);

  api.resetTimingInfo();
  const t4 = performance.now();
  for (const c of callees) checker.getTypeAtLocation(c);
  const t5 = performance.now();
  const unbatched = api.getTimingInfo().totals;

  api.resetTimingInfo();
  const t6 = performance.now();
  checker.getTypeAtLocation(callees);
  const t7 = performance.now();
  const batched = api.getTimingInfo().totals;

  api.close();

  return {
    label,
    calls: calls.length,
    snapshotMs: t1 - t0,
    getSourceFileMs: t2 - t1,
    loadRequests: load.requestCount,
    walkMs: t3 - t2,
    walkRequests: walk.requestCount,
    unbatchedMs: t5 - t4,
    unbatchedReq: unbatched.requestCount,
    unbatchedServerMs: unbatched.serverTimeMs,
    unbatchedTransportMs: unbatched.transportOverheadMs,
    batchedMs: t7 - t6,
    batchedServerMs: batched.serverTimeMs,
  };
}

const N = Number(process.argv[2] ?? 500);
const only = process.argv[3];

const variants = [
  ["independent-1file", (r) => independentOneFile(r, N)],
  ["chain-1file", (r) => chainOneFile(r, N, true)],
  ["chain-1file-inferred", (r) => chainOneFile(r, N, false)],
  ["independent-nfiles", (r) => independentManyFiles(r, N)],
  ["chain-nfiles", (r) => chainManyFiles(r, N, true)],
  ["chain-nfiles-inferred", (r) => chainManyFiles(r, N, false)],
];

console.log(`deep-chain probe, n=${N}\n`);
const header = [
  "variant".padEnd(22),
  "calls".padStart(6),
  "snapshot".padStart(11),
  "getSF".padStart(9),
  "walk".padStart(8),
  "unbatched".padStart(11),
  "ms/req".padStart(8),
  "server".padStart(9),
  "batched".padStart(9),
].join(" ");
console.log(header);
console.log("-".repeat(header.length));

for (const [label, build] of variants) {
  if (only && !label.includes(only)) continue;
  const root = path.resolve(`fixtures/${label}-${N}`);
  const entry = build(root);
  const r = measure(label, root, entry);
  console.log(
    [
      r.label.padEnd(22),
      String(r.calls).padStart(6),
      `${r.snapshotMs.toFixed(0)} ms`.padStart(11),
      `${r.getSourceFileMs.toFixed(0)} ms`.padStart(9),
      `${r.walkMs.toFixed(0)} ms`.padStart(8),
      `${r.unbatchedMs.toFixed(0)} ms`.padStart(11),
      (r.unbatchedMs / Math.max(1, r.unbatchedReq)).toFixed(2).padStart(8),
      `${r.unbatchedServerMs.toFixed(0)} ms`.padStart(9),
      `${r.batchedMs.toFixed(0)} ms`.padStart(9),
    ].join(" "),
  );
}

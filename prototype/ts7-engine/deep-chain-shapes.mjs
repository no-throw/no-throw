/**
 * The plain transitive chain does not reproduce the 35.7 s anomaly (see
 * deep-chain.mjs), so this sweeps the shapes a "f0 <- f1 <- ... <- f499"
 * fixture generator could plausibly have produced instead, plus the shape our
 * fixpoint actually walks (cycles, not paths).
 *
 * Reported anomaly to match: load 35669 ms, walk 1105 ms, unbatched 27950 ms
 * with server 2043 ms and transport 25609 ms => 51.3 ms/request.
 */
import { API } from "@typescript/native-preview/unstable/sync";
import { SyntaxKind } from "@typescript/native-preview/unstable/ast";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const slash = (p) => p.split(path.sep).join("/");

function write(root, src) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", strict: true }, include: ["src"] }),
  );
  writeFileSync(path.join(root, "src", "index.ts"), src);
}

const shapes = {
  /** Forward references: f499 declared first, return types inferred. */
  "chain-topdown-inferred": (n) => {
    let s = "";
    for (let i = n - 1; i >= 1; i--) s += `export function f${i}(x: string) { return f${i - 1}(x); }\n`;
    s += `export function f0(x: string) { return x.length; }\n`;
    return s;
  },
  /** 500-deep lexical nesting — each function declared inside the previous. */
  "nested-closures": (n) => {
    let open = "";
    let close = "";
    for (let i = n - 1; i >= 1; i--) {
      open += `export function f${i}(x: string): number { function f${i - 1}(y: string): number {`;
      close += `} return f${i - 1}(x); }\n`;
    }
    return open + " return x.length; " + close;
  },
  /** One 500-deep call expression, rather than 500 shallow ones. */
  "nested-calls": (n) => {
    let s = "declare function g(x: number): number;\n";
    s += "export function deep(x: number): number { return " + "g(".repeat(n) + "x" + ")".repeat(n) + "; }\n";
    return s;
  },
  /** Mutual recursion: the SCC shape the fixpoint condenses. */
  "cycle": (n) => {
    let s = "";
    for (let i = 0; i < n; i++) {
      s += `export function f${i}(x: string): number { return f${(i + 1) % n}(x); }\n`;
    }
    return s;
  },
  /** Same cycle with inferred returns, which is genuinely circular. */
  "cycle-inferred": (n) => {
    let s = "";
    for (let i = 0; i < n; i++) {
      s += `export function f${i}(x: string) { return x.length + f${(i + 1) % n}(x); }\n`;
    }
    return s;
  },
  /** Widening chain: each return type is structurally bigger than the last. */
  "widening-chain": (n) => {
    let s = "export function f0(x: string) { return { a0: x }; }\n";
    for (let i = 1; i < n; i++) {
      s += `export function f${i}(x: string) { return { ...f${i - 1}(x), a${i}: x }; }\n`;
    }
    return s;
  },
  /** Generic instantiation chain — each layer wraps the last in a type argument. */
  "generic-chain": (n) => {
    let s = "interface Box<T> { v: T }\nexport function f0(x: string): Box<string> { return { v: x }; }\n";
    for (let i = 1; i < n; i++) {
      s += `export function f${i}(x: string) { return { v: f${i - 1}(x) }; }\n`;
    }
    return s;
  },
};

function measure(root) {
  const cfg = slash(path.join(root, "tsconfig.json"));
  const file = slash(path.join(root, "src", "index.ts"));
  const api = new API({ cwd: root, collectTiming: true });

  const t0 = performance.now();
  const snapshot = api.updateSnapshot({ openProjects: [cfg] });
  const project = snapshot.getProject(cfg) ?? snapshot.getProjects()[0];
  const sf = project.program.getSourceFile(file);
  const t1 = performance.now();

  api.resetTimingInfo();
  const calls = [];
  (function walk(node) {
    if (node.kind === SyntaxKind.CallExpression) calls.push(node);
    node.forEachChild(walk);
  })(sf);
  const t2 = performance.now();

  const checker = project.checker;
  const callees = calls.map((c) => c.expression);

  api.resetTimingInfo();
  const t3 = performance.now();
  for (const c of callees) checker.getTypeAtLocation(c);
  const t4 = performance.now();
  const unbatched = api.getTimingInfo().totals;

  api.resetTimingInfo();
  const t5 = performance.now();
  checker.getTypeAtLocation(callees);
  const t6 = performance.now();

  api.close();
  return {
    calls: calls.length,
    loadMs: t1 - t0,
    walkMs: t2 - t1,
    unbatchedMs: t4 - t3,
    perReq: (t4 - t3) / Math.max(1, unbatched.requestCount),
    serverMs: unbatched.serverTimeMs,
    transportMs: unbatched.transportOverheadMs,
    batchedMs: t6 - t5,
  };
}

const N = Number(process.argv[2] ?? 500);
const only = process.argv[3];

const header = [
  "shape".padEnd(24),
  "calls".padStart(6),
  "load".padStart(10),
  "walk".padStart(9),
  "unbatched".padStart(11),
  "ms/req".padStart(8),
  "server".padStart(9),
  "transport".padStart(11),
  "batched".padStart(9),
].join(" ");
console.log(`deep-chain shape sweep, n=${N}\n`);
console.log(header);
console.log("-".repeat(header.length));

for (const [label, build] of Object.entries(shapes)) {
  if (only && !label.includes(only)) continue;
  const root = path.resolve(`fixtures/shape-${label}-${N}`);
  write(root, build(N));
  let r;
  try {
    r = measure(root);
  } catch (e) {
    console.log(`${label.padEnd(24)} FAILED: ${e.message}`);
    continue;
  }
  console.log(
    [
      label.padEnd(24),
      String(r.calls).padStart(6),
      `${r.loadMs.toFixed(0)} ms`.padStart(10),
      `${r.walkMs.toFixed(0)} ms`.padStart(9),
      `${r.unbatchedMs.toFixed(0)} ms`.padStart(11),
      r.perReq.toFixed(2).padStart(8),
      `${r.serverMs.toFixed(0)} ms`.padStart(9),
      `${r.transportMs.toFixed(0)} ms`.padStart(11),
      `${r.batchedMs.toFixed(0)} ms`.padStart(9),
    ].join(" "),
  );
}

/**
 * The anomaly did not reproduce at n=500 on any chain shape, so this checks the
 * two remaining explanations:
 *
 *   scaling — is there a superlinear knee past 500 that the original fixture
 *             happened to sit above?
 *   cold    — is the first API instantiation in a process (or the first run of
 *             the platform binary) paying a one-off cost large enough to be
 *             mistaken for a checker pathology?
 *
 * Run with `--cold` from a fresh process to see the first-instantiation cost in
 * isolation.
 */
import { API } from "@typescript/native-preview/unstable/sync";
import { SyntaxKind } from "@typescript/native-preview/unstable/ast";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const slash = (p) => p.split(path.sep).join("/");

function chain(root, n) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", strict: true }, include: ["src"] }),
  );
  let s = `export function f0(x: string): number { return x.length; }\n`;
  for (let i = 1; i < n; i++) s += `export function f${i}(x: string): number { return f${i - 1}(x); }\n`;
  writeFileSync(path.join(root, "src", "index.ts"), s);
}

function measure(root) {
  const cfg = slash(path.join(root, "tsconfig.json"));
  const file = slash(path.join(root, "src", "index.ts"));
  const api = new API({ cwd: root, collectTiming: true });

  const t0 = performance.now();
  const snapshot = api.updateSnapshot({ openProjects: [cfg] });
  const project = snapshot.getProject(cfg) ?? snapshot.getProjects()[0];
  const sf = project.program.getSourceFile(file);
  const t1 = performance.now();

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

if (process.argv.includes("--repeat")) {
  // A 35 s load among otherwise-40 ms loads would be an intermittent stall, not
  // a shape effect, so the distribution across fresh instances is what tells
  // the two apart.
  const root = path.resolve("fixtures/scale-repeat");
  chain(root, 500);
  const loads = [];
  const unbatched = [];
  for (let k = 0; k < 12; k++) {
    const r = measure(root);
    loads.push(r.loadMs);
    unbatched.push(r.unbatchedMs);
  }
  const stat = (a) => {
    const s = [...a].sort((x, y) => x - y);
    return `min ${s[0].toFixed(0)} / med ${s[Math.floor(s.length / 2)].toFixed(0)} / max ${s[s.length - 1].toFixed(0)} ms`;
  };
  console.log("12 fresh API instances, n=500 annotated chain");
  console.log("  load     :", stat(loads));
  console.log("  unbatched:", stat(unbatched));
  process.exit(0);
}

if (process.argv.includes("--cold")) {
  // One instantiation, nothing before it, so the number is the process's first
  // contact with the platform binary.
  const root = path.resolve("fixtures/scale-cold");
  chain(root, 100);
  const r = measure(root);
  console.log(`cold first instantiation (n=100): load ${r.loadMs.toFixed(0)} ms, unbatched ${r.unbatchedMs.toFixed(0)} ms`);
  process.exit(0);
}

const header = [
  "n".padStart(6),
  "calls".padStart(7),
  "load".padStart(10),
  "walk".padStart(9),
  "unbatched".padStart(11),
  "ms/req".padStart(8),
  "server".padStart(9),
  "transport".padStart(11),
  "batched".padStart(9),
].join(" ");
console.log("transitive-chain scaling (annotated, one file)\n");
console.log(header);
console.log("-".repeat(header.length));

for (const n of [100, 500, 1000, 2000, 4000, 8000]) {
  const root = path.resolve(`fixtures/scale-${n}`);
  chain(root, n);
  const r = measure(root);
  console.log(
    [
      String(n).padStart(6),
      String(r.calls).padStart(7),
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

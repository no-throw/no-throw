import { API } from "@typescript/native-preview/unstable/sync";
import { SyntaxKind } from "@typescript/native-preview/unstable/ast";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const slash = (p) => p.split(path.sep).join("/");

function makeFixture(root, n) {
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", strict: true }, include: ["src"] }),
  );
  // Independent functions (no deep chain) so we measure per-query cost,
  // not pathological inference depth.
  let src = "declare function helper(x: string): number;\n";
  for (let i = 0; i < n; i++) {
    src += `/** @nothrow */\nexport function f${i}(x: string): number { return helper(x); }\n`;
  }
  writeFileSync(path.join(root, "src", "index.ts"), src);
}

function run(n) {
  const root = path.resolve(`bench-${n}`);
  makeFixture(root, n);
  const cfg = slash(path.join(root, "tsconfig.json"));
  const file = slash(path.join(root, "src", "index.ts"));

  const api = new API({ cwd: root, collectTiming: true });

  const a = performance.now();
  const snapshot = api.updateSnapshot({ openProjects: [cfg] });
  const project = snapshot.getProject(cfg) ?? snapshot.getProjects()[0];
  const b = performance.now();
  const sf = project.program.getSourceFile(file);
  const c = performance.now();
  const afterLoad = api.getTimingInfo().totals;

  api.resetTimingInfo();
  const calls = [];
  (function walk(node) {
    if (node.kind === SyntaxKind.CallExpression) calls.push(node);
    node.forEachChild(walk);
  })(sf);
  const d = performance.now();
  const walkT = api.getTimingInfo().totals;

  const checker = project.checker;
  const callees = calls.map((x) => x.expression);

  api.resetTimingInfo();
  const e = performance.now();
  for (const x of callees) checker.getTypeAtLocation(x);
  const f = performance.now();
  const unb = api.getTimingInfo().totals;

  api.resetTimingInfo();
  const g = performance.now();
  checker.getTypeAtLocation(callees);
  const h = performance.now();
  const bat = api.getTimingInfo().totals;

  api.close();

  return {
    n,
    calls: calls.length,
    snapshotMs: b - a,
    getSourceFileMs: c - b,
    loadRequests: afterLoad.requestCount,
    walkMs: d - c,
    walkRequests: walkT.requestCount,
    walkNodesFetched: walkT.nodesFetched,
    unbatchedMs: f - e,
    unbatchedReq: unb.requestCount,
    unbatchedServerMs: unb.serverTimeMs,
    unbatchedTransportMs: unb.transportOverheadMs,
    batchedMs: h - g,
    batchedReq: bat.requestCount,
  };
}

console.log("phase timings by fixture size (independent functions, 1 call each)\n");
for (const n of [10, 100, 500]) {
  const r = run(n);
  console.log(`n=${String(r.n).padStart(4)}  calls=${String(r.calls).padStart(4)}`);
  console.log(`   updateSnapshot   ${r.snapshotMs.toFixed(1).padStart(9)} ms   (${r.loadRequests} reqs incl. getSourceFile)`);
  console.log(`   getSourceFile    ${r.getSourceFileMs.toFixed(1).padStart(9)} ms`);
  console.log(`   AST walk         ${r.walkMs.toFixed(1).padStart(9)} ms   requests=${r.walkRequests} nodesFetched=${r.walkNodesFetched}`);
  console.log(`   unbatched types  ${r.unbatchedMs.toFixed(1).padStart(9)} ms   reqs=${r.unbatchedReq} server=${r.unbatchedServerMs.toFixed(1)} transport=${r.unbatchedTransportMs.toFixed(1)}  => ${(r.unbatchedTransportMs / Math.max(1, r.unbatchedReq)).toFixed(2)} ms/req transport`);
  console.log(`   batched types    ${r.batchedMs.toFixed(1).padStart(9)} ms   reqs=${r.batchedReq}`);
  console.log(`   batching speedup ${(r.unbatchedMs / r.batchedMs).toFixed(0)}x\n`);
}

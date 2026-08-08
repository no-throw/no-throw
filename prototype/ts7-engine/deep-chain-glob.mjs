/**
 * Last candidate for the 35.7 s anomaly: a tsconfig with no `include`, rooted
 * at a directory that also holds `node_modules`. TypeScript then includes every
 * file under the config directory, so the "500-function chain" project silently
 * becomes "500-function chain plus every `.d.ts` in node_modules".
 *
 * The surviving bench script scopes its fixture with `include: ["src"]`. The
 * deep-chain script was not preserved, so this tests whether dropping that one
 * line reproduces the reported magnitude.
 */
import { API } from "@typescript/native-preview/unstable/sync";
import { SyntaxKind } from "@typescript/native-preview/unstable/ast";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const slash = (p) => p.split(path.sep).join("/");

function chainSource(n) {
  let s = `export function f0(x: string): number { return x.length; }\n`;
  for (let i = 1; i < n; i++) s += `export function f${i}(x: string): number { return f${i - 1}(x); }\n`;
  return s;
}

/**
 * `scoped: false` writes the tsconfig at the spike root, next to node_modules,
 * with no `include`. `scoped: true` is the controlled fixture for comparison.
 */
function build(n, scoped) {
  if (scoped) {
    const root = path.resolve(`fixtures/glob-scoped-${n}`);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { target: "ES2022", strict: true }, include: ["src"] }),
    );
    writeFileSync(path.join(root, "src", "index.ts"), chainSource(n));
    return { root, cfg: slash(path.join(root, "tsconfig.json")), file: slash(path.join(root, "src", "index.ts")) };
  }
  // Unscoped: config sits at the spike root, so node_modules is in the program.
  const root = path.resolve(".");
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "chain.ts"), chainSource(n));
  const cfgPath = path.join(root, "tsconfig.glob.json");
  writeFileSync(cfgPath, JSON.stringify({ compilerOptions: { target: "ES2022", strict: true } }));
  return { root, cfg: slash(cfgPath), file: slash(path.join(root, "src", "chain.ts")) };
}

function measure({ root, cfg, file }) {
  const api = new API({ cwd: root, collectTiming: true });
  const t0 = performance.now();
  const snapshot = api.updateSnapshot({ openProjects: [cfg] });
  const project = snapshot.getProject(cfg) ?? snapshot.getProjects()[0];
  const sf = project.program.getSourceFile(file);
  const t1 = performance.now();
  if (!sf) {
    api.close();
    return { missing: true, loadMs: t1 - t0 };
  }

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

  const files = project.program.getSourceFileNames().length;
  api.close();
  return {
    files,
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
for (const scoped of [true, false]) {
  const label = scoped ? "include: [src]" : "no include (node_modules in program)";
  const r = measure(build(N, scoped));
  if (r.missing) {
    console.log(`${label.padEnd(38)} source file not in program (load ${r.loadMs.toFixed(0)} ms)`);
    continue;
  }
  console.log(
    `${label.padEnd(38)} files=${String(r.files).padStart(5)}  load=${r.loadMs.toFixed(0).padStart(7)} ms  ` +
      `walk=${r.walkMs.toFixed(0).padStart(6)} ms  unbatched=${r.unbatchedMs.toFixed(0).padStart(7)} ms  ` +
      `${r.perReq.toFixed(2)} ms/req  server=${r.serverMs.toFixed(0)} ms  transport=${r.transportMs.toFixed(0)} ms  ` +
      `batched=${r.batchedMs.toFixed(0)} ms`,
  );
}

/**
 * What the engine would cost over a wire, measured in process.
 *
 * The seam (`TypeFacts`) makes this measurable without a tsgo server: wrap the
 * in-process implementation in a recorder, run the real engine over a real
 * project, and count what crosses. `prime` is where the batching restructure
 * shows up — a primed node is one that would have ridden an array overload, so
 * the request count is
 *
 *     one request per prime batch, plus one per unprimed type query
 *
 * against `one per type query` for the unbatched shape #81 priced at ~24x the
 * whole in-process pass.
 *
 * Usage: node request-cost.mjs [tsconfig.json ...]
 * With no arguments it dogfoods `@nothrow/core` itself.
 */
import { analyzeSourceFile, typeFactsOf } from "@nothrow/core";
import path from "node:path";
import ts from "typescript";

/** Every operation the port exposes, so nothing crosses uncounted. */
const OPERATIONS = [
  "typeAt",
  "symbolAt",
  "signatureAt",
  "typeOfSymbolAt",
  "destructuredProperty",
  "apparentType",
  "awaitedType",
  "baseConstraintOf",
  "constituentsOf",
  "isUnion",
  "callSignaturesOf",
  "propertyOfType",
  "propertiesOfType",
  "wellKnownMember",
  "symbolOfType",
  "stringLiteralValue",
  "isOpaque",
  "isPrimitive",
  "typeOfSymbol",
  "nameOf",
  "escapedNameOf",
  "valueDeclarationOf",
  "declarationsOf",
  "isAlias",
  "aliasedSymbol",
  "exportsOfModule",
  "membersOfSymbol",
  "exportsOfSymbol",
  "returnTypeOf",
  "declarationOf",
];

/**
 * The two operations tsgo answers in bulk. Everything else is one round trip
 * whatever the engine does, so batching cannot help it and it is counted apart.
 */
const BATCHABLE = new Set(["typeAt", "symbolAt"]);

function recording(inner) {
  const calls = Object.fromEntries(OPERATIONS.map((name) => [name, 0]));
  const stats = { primeBatches: 0, primedNodes: 0, primeHits: 0 };
  const primed = new Set();

  const facts = {
    prime(nodes) {
      if (nodes.length === 0) return;
      stats.primeBatches += 1;
      stats.primedNodes += nodes.length;
      for (const node of nodes) primed.add(node);
    },
  };

  for (const name of OPERATIONS) {
    facts[name] = (...args) => {
      calls[name] += 1;
      if (BATCHABLE.has(name) && primed.has(args[0])) stats.primeHits += 1;
      return inner[name](...args);
    };
  }

  const total = () => Object.values(calls).reduce((a, b) => a + b, 0);
  return { facts, calls, stats, total };
}

function analyze(configPath) {
  const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, " "));
    },
  });
  if (config === undefined) throw new Error(`could not read ${configPath}`);

  const buildStart = performance.now();
  const program = ts.createProgram(config.fileNames, config.options);
  const checker = program.getTypeChecker();
  const buildMs = performance.now() - buildStart;

  const root = path.dirname(configPath);
  const sources = program
    .getSourceFiles()
    .filter(
      (file) =>
        !file.isDeclarationFile &&
        !program.isSourceFileFromExternalLibrary(file) &&
        path.resolve(file.fileName).startsWith(path.resolve(root)),
    );

  const recorder = recording(typeFactsOf(checker));
  let findings = 0;

  // The export-surface walk is memoized per program, so whichever file trips it
  // first pays for all of them. Per-file counts are what separate that startup
  // cost from the per-file one, and only the second scales with the project.
  const perFile = [];
  let running = 0;
  const analyzeStart = performance.now();
  for (const file of sources) {
    findings += analyzeSourceFile(file, program, recorder.facts).length;
    const now = recorder.total();
    perFile.push({ file: path.basename(file.fileName), queries: now - running });
    running = now;
  }
  const analyzeMs = performance.now() - analyzeStart;

  return {
    buildMs,
    analyzeMs,
    files: sources.length,
    findings,
    perFile,
    ...recorder,
  };
}

const configs =
  process.argv.length > 2
    ? process.argv.slice(2)
    : [path.resolve("../../packages/core/tsconfig.json")];

for (const configPath of configs) {
  const r = analyze(path.resolve(configPath));
  const total = Object.values(r.calls).reduce((a, b) => a + b, 0);
  const batchable = [...BATCHABLE].reduce((a, name) => a + r.calls[name], 0);
  const unbatchable = total - batchable;

  // Only a primed batchable call rides an array overload; the rest are one
  // round trip each however they were reached.
  const unprimed = batchable - r.stats.primeHits;
  const batchedRequests = r.stats.primeBatches + unprimed + unbatchable;

  console.log(`\n${configPath}`);
  console.log(`  ${r.files} files, ${r.findings} findings`);
  const ranked = [...r.perFile].sort((a, b) => b.queries - a.queries);
  const heaviest = ranked.slice(0, 3);
  const rest = ranked.slice(3).reduce((a, f) => a + f.queries, 0);
  console.log(
    `  heaviest files     ${heaviest.map((f) => `${f.file}=${f.queries}`).join(", ")}` +
      `  |  other ${r.files - heaviest.length} files=${rest}`,
  );
  console.log(`  program build      ${r.buildMs.toFixed(0).padStart(7)} ms`);
  console.log(`  analysis           ${r.analyzeMs.toFixed(0).padStart(7)} ms   (in process)`);
  console.log(`  type queries       ${String(total).padStart(7)}   (${batchable} batchable, ${unbatchable} not)`);
  console.log(`  prime batches      ${String(r.stats.primeBatches).padStart(7)}   covering ${r.stats.primedNodes} nodes, ${r.stats.primeHits} hits`);
  console.log(`  wire requests`);
  console.log(`    per-node pull    ${String(total).padStart(7)}`);
  console.log(`    per-pass batch   ${String(batchedRequests).padStart(7)}   (${(total / Math.max(1, batchedRequests)).toFixed(1)}x fewer)`);

  const perRequestMs = 0.05;
  console.log(`  projected transport at ${perRequestMs} ms/request`);
  console.log(`    per-node pull    ${(total * perRequestMs).toFixed(0).padStart(7)} ms`);
  console.log(`    per-pass batch   ${(batchedRequests * perRequestMs).toFixed(0).padStart(7)} ms`);

  const top = Object.entries(r.calls)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  console.log(`  hottest operations: ${top.map(([n, c]) => `${n}=${c}`).join(", ")}`);
}

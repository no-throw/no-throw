/**
 * What the engine would cost over a wire, measured in process.
 *
 * The seam (`TypeFacts`) makes this measurable without a tsgo server: wrap the
 * in-process implementation in a recorder, run the real engine over a real
 * project, and count what crosses. Out of process every one of these is a round
 * trip, and #81 found the count — not the traversal order — is what decides the
 * bill.
 *
 * The batchable split is what killed the batching plan. Only two of the port's
 * operations have array overloads on tsgo, and they are a small minority of
 * what the engine asks, so even a perfect prefetch could not collapse the rest.
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
  "wellKnownNameOf",
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
 * however the engine reaches it, which is the ceiling any batching scheme has
 * to work under.
 */
const BATCHABLE = new Set(["typeAt", "symbolAt"]);

/** What one round trip cost, measured across every fixture shape in #81. */
const PER_REQUEST_MS = 0.05;

function recording(inner) {
  const calls = Object.fromEntries(OPERATIONS.map((name) => [name, 0]));
  const facts = {};
  for (const name of OPERATIONS) {
    facts[name] = (...args) => {
      calls[name] += 1;
      return inner[name](...args);
    };
  }
  const total = () => Object.values(calls).reduce((a, b) => a + b, 0);
  return { facts, calls, total };
}

function analyze(configPath) {
  const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(
        ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
      );
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

  // Per-file counts separate a fixed startup cost — the export-surface walk is
  // memoized per program, so whichever file trips it first pays for all of them
  // — from the per-file one. Only the second scales with the project.
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
  const total = r.total();
  const batchable = [...BATCHABLE].reduce((sum, name) => sum + r.calls[name], 0);

  const ranked = [...r.perFile].sort((a, b) => b.queries - a.queries);
  const heaviest = ranked.slice(0, 3);
  const rest = ranked.slice(3).reduce((sum, f) => sum + f.queries, 0);

  console.log(`\n${configPath}`);
  console.log(`  ${r.files} files, ${r.findings} findings`);
  console.log(
    `  heaviest files     ${heaviest.map((f) => `${f.file}=${f.queries}`).join(", ")}` +
      `  |  other ${Math.max(0, r.files - heaviest.length)} files=${rest}`,
  );
  console.log(`  program build      ${r.buildMs.toFixed(0).padStart(7)} ms`);
  console.log(`  analysis           ${r.analyzeMs.toFixed(0).padStart(7)} ms   (in process)`);
  console.log(
    `  type queries       ${String(total).padStart(7)}   ` +
      `(${batchable} batchable = ${((100 * batchable) / Math.max(1, total)).toFixed(0)}%, ${total - batchable} not)`,
  );
  console.log(
    `  projected transport ${(total * PER_REQUEST_MS).toFixed(0).padStart(6)} ms   at ${PER_REQUEST_MS} ms/request`,
  );

  const top = Object.entries(r.calls)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  console.log(`  hottest operations: ${top.map(([n, c]) => `${n}=${c}`).join(", ")}`);
}

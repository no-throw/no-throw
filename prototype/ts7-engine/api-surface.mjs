/**
 * The engine's whole compiler-API surface, checked against tsgo at runtime.
 *
 * The research note checked seven checker methods off a hand-written list and
 * concluded the surface was sufficient. That list was the methods it happened to
 * name; this walks what `@nothrow/core` actually calls — checker methods, the
 * members it reads off Type/Symbol/Signature objects, and the `ts.*` module-level
 * helpers — and reports each as present, renamed, or missing.
 *
 * "Declared" and "works" are different claims, so anything present is also
 * exercised against a fixture rather than trusted from the `.d.ts`.
 */
import { API } from "@typescript/native-preview/unstable/sync";
import * as tsgoSync from "@typescript/native-preview/unstable/sync";
import * as tsgoAst from "@typescript/native-preview/unstable/ast";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const slash = (p) => p.split(path.sep).join("/");

const FIXTURE = `
export interface Repo { readonly rows: readonly string[]; get first(): string; }
export class Base { constructor(public n: number) {} }
export class Sub extends Base { static make(): Sub { return new Sub(1); } }
/** @nothrow */
export function marked(x: string): number { return x.length; }
export function risky(x: string): number { if (x === "") throw new Error("no"); return 1; }
export async function later(x: string): Promise<number> { return marked(x); }
export function use(r: Repo, x: string): number {
  const [head] = r.rows;
  const { first } = r;
  return marked(x) + risky(head ?? first) + r.rows.length;
}
export function consume(xs: Iterable<number>): number {
  let total = 0;
  for (const x of xs) total += x;
  return total;
}
`;

const root = path.resolve("fixtures/api-surface");
rmSync(root, { recursive: true, force: true });
mkdirSync(path.join(root, "src"), { recursive: true });
writeFileSync(
  path.join(root, "tsconfig.json"),
  JSON.stringify({ compilerOptions: { target: "ES2022", strict: true, lib: ["ES2022"] }, include: ["src"] }),
);
writeFileSync(path.join(root, "src", "index.ts"), FIXTURE);

const cfg = slash(path.join(root, "tsconfig.json"));
const file = slash(path.join(root, "src", "index.ts"));
const api = new API({ cwd: root });
const snapshot = api.updateSnapshot({ openProjects: [cfg] });
const project = snapshot.getProject(cfg) ?? snapshot.getProjects()[0];
const { checker } = project;
const sf = project.program.getSourceFile(file);

const { SyntaxKind } = tsgoAst;
const nodes = [];
(function walk(n) {
  nodes.push(n);
  n.forEachChild(walk);
})(sf);
const firstOf = (kind) => nodes.find((n) => n.kind === kind);

const call = firstOf(SyntaxKind.CallExpression);
const ident = firstOf(SyntaxKind.Identifier);
const iface = firstOf(SyntaxKind.InterfaceDeclaration);
const classDecl = firstOf(SyntaxKind.ClassDeclaration);
const forOf = firstOf(SyntaxKind.ForOfStatement);
const objBinding = firstOf(SyntaxKind.ObjectBindingPattern);

/**
 * Each entry names an engine call and how to make it against tsgo. `run` throws
 * or returns `undefined` for "declared but does not do the job"; a missing
 * method is reported before `run` is ever reached.
 */
const checkerOps = [
  ["getTypeAtLocation", "getTypeAtLocation", () => checker.getTypeAtLocation(call.expression)],
  ["getSymbolAtLocation", "getSymbolAtLocation", () => checker.getSymbolAtLocation(call.expression)],
  ["getApparentType", "getApparentType", () => checker.getApparentType(checker.getStringType())],
  [
    "getPropertyOfType",
    "getPropertyOfType",
    () => checker.getPropertyOfType(checker.getApparentType(checker.getStringType()), "length"),
  ],
  [
    "getTypeOfSymbol",
    "getTypeOfSymbol",
    () => checker.getTypeOfSymbol(checker.getSymbolAtLocation(call.expression)),
  ],
  ["getResolvedSignature", "getResolvedSignature", () => checker.getResolvedSignature(call)],
  [
    "getPropertiesOfType",
    "getPropertiesOfType",
    () => checker.getPropertiesOfType(checker.getApparentType(checker.getStringType())),
  ],
  [
    "getDeclaredTypeOfSymbol",
    "getDeclaredTypeOfSymbol",
    () => checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(iface.name)),
  ],
  [
    "getBaseConstraintOfType",
    "getBaseConstraintOfType",
    () => checker.getBaseConstraintOfType(checker.getStringType()) ?? "(null constraint, call succeeded)",
  ],
  ["typeToString", "typeToString", () => checker.typeToString(checker.getStringType())],
  [
    "getTypeOfSymbolAtLocation",
    "getTypeOfSymbolAtLocation",
    () => checker.getTypeOfSymbolAtLocation(checker.getSymbolAtLocation(call.expression), call),
  ],
  [
    "getTypeArguments",
    "getTypeArguments",
    () => {
      const t = checker.getTypeAtLocation(forOf.expression);
      return checker.getTypeArguments(t) ?? "(empty, call succeeded)";
    },
  ],
  [
    "getExportsOfModule",
    "getExportsOfModule",
    () => checker.getExportsOfModule(checker.getSymbolAtLocation(sf)),
  ],
  [
    "getBaseTypes",
    "getBaseTypes",
    () => checker.getBaseTypes(checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(classDecl.name))),
  ],
  [
    "getAliasedSymbol",
    "getAliasedSymbol",
    // No alias in the fixture; the point is that the method exists and is callable.
    () => (typeof checker.getAliasedSymbol === "function" ? "(callable)" : undefined),
  ],
  // The three the research note's list did not cover.
  ["getAwaitedType", "getAwaitedType", () => checker.getAwaitedType?.(checker.getTypeAtLocation(call.expression))],
  [
    "getIndexTypeOfType",
    "getIndexTypeOfType / getIndexInfosOfType",
    () =>
      checker.getIndexTypeOfType?.(checker.getStringType(), 1) ??
      (checker.getIndexInfosOfType ? "(via getIndexInfosOfType)" : undefined),
  ],
  [
    "getPropertySymbolOfDestructuringAssignment",
    "getPropertySymbolOfDestructuringAssignment",
    () => checker.getPropertySymbolOfDestructuringAssignment?.(objBinding ?? ident),
  ],
  // Reached off the object in TS, off the checker in tsgo.
  [
    "type.getCallSignatures()",
    "getSignaturesOfType(type, Call)",
    () => checker.getSignaturesOfType?.(checker.getTypeAtLocation(call.expression), 0) ?? undefined,
  ],
  [
    "signature.getReturnType()",
    "getReturnTypeOfSignature",
    () => checker.getReturnTypeOfSignature(checker.getResolvedSignature(call)),
  ],
  ["JSDoc carrier", "getJsDocTagsOfSymbol", () => checker.getJsDocTagsOfSymbol(checker.getSymbolAtLocation(call.expression))],
];

console.log("checker operations the engine calls\n");
const gaps = [];
for (const [engineCall, tsgoName, run] of checkerOps) {
  const method = tsgoName.split(/[ (/]/)[0];
  const declared = typeof checker[method] === "function";
  let verdict;
  if (!declared) {
    verdict = "MISSING";
    gaps.push(engineCall);
  } else {
    try {
      const value = run();
      verdict = value === undefined || value === null ? "declared, returned nothing" : "ok";
      if (verdict !== "ok") gaps.push(`${engineCall} (declared but unusable here)`);
    } catch (e) {
      verdict = `threw: ${e.message.slice(0, 60)}`;
      gaps.push(`${engineCall} (${verdict})`);
    }
  }
  const rename = engineCall === tsgoName ? "" : `  -> ${tsgoName}`;
  console.log(`  ${verdict === "ok" ? "ok     " : "PROBLEM"}  ${engineCall.padEnd(44)}${rename}`);
  if (verdict !== "ok" && verdict !== "MISSING") console.log(`           ${verdict}`);
}

// --- module-level helpers -------------------------------------------------
const moduleHelpers = [
  "getJSDocTags",
  "canHaveDecorators",
  "canHaveModifiers",
  "getDecorators",
  "getModifiers",
  "getCombinedModifierFlags",
  "getCombinedNodeFlags",
  "getNameOfDeclaration",
  "getLeadingCommentRanges",
];
console.log("\nts.* module helpers the engine calls\n");
for (const name of moduleHelpers) {
  const present = typeof tsgoAst[name] === "function";
  if (!present) gaps.push(`ts.${name}`);
  console.log(`  ${present ? "ok     " : "MISSING"}  ${name}`);
}

// tsgo splits what TS keeps in one namespace: syntax enums live on the AST
// module, type-system enums on the sync API module.
const enums = ["SyntaxKind", "NodeFlags", "ModifierFlags", "SymbolFlags", "TypeFlags", "IndexKind"];
console.log("\nenums the engine reads\n");
for (const name of enums) {
  const where = tsgoAst[name] !== undefined ? "unstable/ast" : tsgoSync[name] !== undefined ? "unstable/sync" : undefined;
  if (where === undefined) gaps.push(`ts.${name}`);
  console.log(`  ${where === undefined ? "MISSING" : "ok     "}  ${name.padEnd(16)}${where ?? ""}`);
}

// Per-kind predicates: tsgo ships category predicates only, so every
// `ts.isCallExpression`-style check the engine makes has to be shimmed.
// A missing helper only matters if the data it reads is missing too. These are
// the node members a shim would have to stand on.
console.log("\nnode members a shim for the missing helpers would need\n");
const fnDecl = nodes.find((n) => n.kind === SyntaxKind.FunctionDeclaration);
const methodDecl = nodes.find((n) => n.kind === SyntaxKind.MethodDeclaration);
const shimInputs = [
  ["modifiers (for getModifiers/getCombinedModifierFlags)", (methodDecl ?? fnDecl)?.modifiers !== undefined],
  ["name (for getNameOfDeclaration)", fnDecl?.name !== undefined],
  ["flags (for getCombinedNodeFlags)", fnDecl?.flags !== undefined],
  ["parent (for the combined-flags walk)", fnDecl?.parent !== undefined],
  ["jsDoc (for the carrier)", "jsDoc" in (fnDecl ?? {})],
];
for (const [what, present] of shimInputs) {
  if (!present) gaps.push(`node.${what} — shim not possible`);
  console.log(`  ${present ? "ok     " : "MISSING"}  ${what}`);
}

const perKind = Object.keys(tsgoAst).filter((k) => /^is[A-Z]/.test(k));
console.log(`\nper-kind predicates (ts.isCallExpression & co): ${perKind.length} exported by tsgo`);
console.log(`  exported: ${perKind.join(", ")}`);

console.log(`\n${gaps.length} gap(s):`);
for (const gap of gaps) console.log(`  - ${gap}`);

api.close();

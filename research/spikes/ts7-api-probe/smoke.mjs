import { API } from "@typescript/native-preview/unstable/sync";
import { SyntaxKind } from "@typescript/native-preview/unstable/ast";
import path from "node:path";

const slash = (p) => p.split(path.sep).join("/");
const cwd = path.resolve("fixture");
const cfg = slash(path.join(cwd, "tsconfig.json"));
const file = slash(path.join(cwd, "src", "index.ts"));

const api = new API({ cwd, collectTiming: true });
const snapshot = api.updateSnapshot({ openProjects: [cfg] });
const project = snapshot.getProject(cfg) ?? snapshot.getProjects()[0];
const { program, checker } = project;

const sf = program.getSourceFile(file);
console.log("sourceFile:", sf ? "loaded" : "MISSING");

// 1. Walk the AST locally. No IPC — the source file is materialized client-side.
const calls = [];
const fns = [];
(function walk(node) {
  if (node.kind === SyntaxKind.CallExpression) calls.push(node);
  if (node.kind === SyntaxKind.FunctionDeclaration) fns.push(node);
  node.forEachChild(walk);
})(sf);
console.log(`local AST walk: ${calls.length} calls, ${fns.length} function declarations`);
console.log("parent pointers work:", calls[0]?.parent !== undefined);

// 2. BATCHED type query: the array overload resolves every callee in one request.
const callees = calls.map((c) => c.expression);
const types = checker.getTypeAtLocation(callees);
console.log("batched getTypeAtLocation ->", types.map((t) => t && checker.typeToString(t)));

// 3. The no-throw carrier: resolve the callee symbol, read its JSDoc tags.
console.log("\n--- escape-site walk (what no-throw actually does) ---");
const syms = checker.getSymbolAtLocation(callees);
for (let i = 0; i < calls.length; i++) {
  const sym = syms[i];
  const sig = checker.getResolvedSignature(calls[i]);
  const tags = sym ? checker.getJsDocTagsOfSymbol(sym) : [];
  const marked = tags.some((t) => t.name === "nothrow");
  console.log(
    `  ${sym?.name ?? "?"}() -> sig ${sig ? "resolved" : "none"}` +
      ` | return ${sig ? checker.typeToString(checker.getReturnTypeOfSignature(sig)) : "-"}` +
      ` | tags ${JSON.stringify(tags.map((t) => t.name))}` +
      ` | @nothrow: ${marked}`,
  );
}

// 4. Apparent type / property lookup — the hidden-transfer path.
const strType = checker.getStringType();
const lengthProp = checker.getPropertyOfType(checker.getApparentType(strType), "length");
console.log("\ngetApparentType + getPropertyOfType ->", lengthProp?.name);

const t = api.getTimingInfo();
console.log("\n--- timing ---");
console.log(JSON.stringify(t, null, 2).slice(0, 900));

api.close();

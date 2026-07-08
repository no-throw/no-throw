const path = require("path");
const ts = require("typescript");
const parser = require("@typescript-eslint/parser");
const fs = require("fs");

const SRC = path.join(__dirname, "src");
const R = {}; // results

function readFile(f) { return fs.readFileSync(path.join(SRC, f), "utf8"); }

// ---------- Parse consumer.ts as a rule would, to get ParserServices ----------
const consumerPath = path.join(SRC, "consumer.ts");
const { ast, services } = parser.parseForESLint(readFile("consumer.ts"), {
  filePath: consumerPath,
  project: path.join(__dirname, "tsconfig.json"),
  tsconfigRootDir: __dirname,
  sourceType: "module",
  comment: true, loc: true, range: true,
});

R.parserServices = {
  hasProgram: !!services.program,
  hasEsTreeNodeToTSNodeMap: !!services.esTreeNodeToTSNodeMap,
  hasGetTypeChecker: !!(services.program && services.program.getTypeChecker),
};
const checker = services.program.getTypeChecker();

// helper: get TS node for an ESTree node
const tsNodeOf = (n) => services.esTreeNodeToTSNodeMap.get(n);

// ---------- walk ESTree to find call expressions & awaits ----------
const calls = [];
const awaits = [];
(function walk(node, parents) {
  if (!node || typeof node.type !== "string") return;
  if (node.type === "CallExpression") calls.push({ node, parents: [...parents] });
  if (node.type === "AwaitExpression") awaits.push({ node, parents: [...parents] });
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (k === "parent") continue;
    if (Array.isArray(v)) v.forEach((c) => c && c.type && walk(c, [...parents, node]));
    else if (v && typeof v.type === "string") walk(v, [...parents, node]);
  }
})(ast, []);

// ---------- Q1: cross-file color read (brand + JSDoc) for each call ----------
function calleeName(callNode) {
  const c = callNode.callee;
  if (c && c.type === "Identifier") return c.name;
  return "(complex)";
}

function isInsideCatchingTry(parents, callTsNode) {
  // AST-only: is this call within the try-block of a try that has a catch clause?
  for (let i = parents.length - 1; i >= 0; i--) {
    const p = parents[i];
    if (p.type === "TryStatement") {
      const child = parents[i + 1] || null;
      // must be in the `block`, not in handler/finalizer, and try must have a handler
      if (p.handler && child && p.block === child) return true;
    }
    if (p.type === "CatchClause") return false; // inside catch itself
  }
  return false;
}

R.callSites = calls.map(({ node, parents }) => {
  const name = calleeName(node);
  const tsCall = tsNodeOf(node);
  let sig = null, retTypeStr = null, brand = null, jsdoc = null, declFile = null;
  try {
    const t = checker.getTypeAtLocation(tsCall.expression); // type of callee
    sig = checker.getSignaturesOfType(t, ts.SignatureKind.Call)[0] || null;
    if (sig) {
      const rt = checker.getReturnTypeOfSignature(sig);
      retTypeStr = checker.typeToString(rt);
      // Brand detection strategies:
      const aliasName = rt.aliasSymbol && rt.aliasSymbol.getName();
      let hasBrandProp = false;
      const props = rt.getProperties ? rt.getProperties() : [];
      for (const pr of props) {
        // symbol-keyed optional brand prop shows as "__@NOTHROW" style escaped name
        if (String(pr.escapedName).includes("NOTHROW")) hasBrandProp = true;
      }
      // For awaited/promise, also peel one Promise layer
      let awaited = null;
      const at = checker.getAwaitedType ? checker.getAwaitedType(rt) : null;
      if (at && at !== rt) {
        awaited = checker.typeToString(at);
        const aprops = at.getProperties ? at.getProperties() : [];
        for (const pr of aprops) if (String(pr.escapedName).includes("NOTHROW")) hasBrandProp = true;
        if (at.aliasSymbol && at.aliasSymbol.getName() === "Safe") hasBrandProp = true;
      }
      brand = { aliasName: aliasName || null, hasBrandProp, awaited };
      // JSDoc tags on the callee symbol (cross-file)
      const calleeSym = checker.getSymbolAtLocation(tsCall.expression);
      if (calleeSym) {
        const tags = calleeSym.getJsDocTags(checker).map((tg) => tg.name);
        jsdoc = tags;
        const decls = calleeSym.getDeclarations() || [];
        if (decls[0]) declFile = path.basename(decls[0].getSourceFile().fileName);
      }
    }
  } catch (e) { retTypeStr = "ERR:" + e.message; }
  return {
    callee: name,
    declaredIn: declFile,
    returnType: retTypeStr,
    brand,
    jsdocTags: jsdoc,
    insideCatchingTry: isInsideCatchingTry(parents, tsCall),
  };
});

// ---------- Q3: await surfaces promise/awaited type ----------
R.awaits = awaits.map(({ node }) => {
  const tsAwait = tsNodeOf(node);
  const inner = node.argument;
  const tsInner = tsNodeOf(inner);
  let promised = null, awaitedType = null;
  try {
    const t = checker.getTypeAtLocation(tsInner);
    awaitedType = checker.typeToString(t);
    const promisedT = checker.getPromisedTypeOfPromise ? checker.getPromisedTypeOfPromise(t) : null;
    promised = promisedT ? checker.typeToString(promisedT) : null;
  } catch (e) { awaitedType = "ERR:" + e.message; }
  return { awaitedExprType: awaitedType, promisedType: promised };
});

// ---------- Q1b: does @nothrow survive into emitted .d.ts? ----------
(function emitDts() {
  const configPath = path.join(__dirname, "tsconfig.json");
  const cfg = ts.readConfigFile(configPath, ts.sys.readFile).config;
  const parsed = ts.parseJsonConfigFileContent(cfg, ts.sys, __dirname);
  const outputs = {};
  const host = ts.createCompilerHost(parsed.options);
  const program = ts.createProgram([path.join(SRC, "lib.ts")], parsed.options, host);
  program.emit(undefined, (fileName, data) => { outputs[path.basename(fileName)] = data; }, undefined, true);
  const dts = outputs["lib.d.ts"] || Object.values(outputs)[0] || "";
  R.dts = {
    emittedFiles: Object.keys(outputs),
    nothrowSurvives: /@nothrow/.test(dts),
    safeTypeSurvives: /Safe<|type Safe/.test(dts),
    snippet: dts.split("\n").filter(l => /nothrow|parseIntSafe|Safe/i.test(l)).slice(0, 8),
  };
})();

console.log(JSON.stringify(R, null, 2));

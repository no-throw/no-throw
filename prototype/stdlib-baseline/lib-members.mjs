// PROTOTYPE — throwaway. Spike for https://github.com/MidnightDesign/no-throw/issues/22
//
// Inventory of TypeScript's own lib.*.d.ts members, keyed the way the spec names
// them (Array.prototype.push, Object.keys, …) and tagged with the lib target the
// declaration came from — the join key for the ecmarkup extraction.
//
// Run: node lib-members.mjs   Emits: ./out/lib-members.json

const ts = (await import(process.env.TS_MODULE ?? "typescript")).default;
import { writeFileSync, mkdirSync, writeFileSync as wf } from "node:fs";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const OUT = process.env.OUT ?? './out/lib-members.json';
const tsLibDir = require_
  .resolve("typescript")
  .replace(/[\\/]typescript\.js$/, "");

// One program over an empty file with the full esnext + dom lib set.
const host = ts.createCompilerHost({});
const entry = "____probe.ts";
const origGet = host.getSourceFile.bind(host);
host.getSourceFile = (name, ...rest) =>
  name === entry
    ? ts.createSourceFile(entry, "export {};", ts.ScriptTarget.ESNext, true)
    : origGet(name, ...rest);
host.fileExists = (n) => n === entry || ts.sys.fileExists(n);
host.readFile = (n) => (n === entry ? "export {};" : ts.sys.readFile(n));

const program = ts.createProgram([entry], {
  target: ts.ScriptTarget.ESNext,
  lib: ["lib.esnext.full.d.ts"],
  strict: true,
  noLib: false,
}, host);

const checker = program.getTypeChecker();

// interface name -> declarations, plus `declare var X: XConstructor` links
const interfaces = new Map(); // name -> [decl]
const varTypes = new Map(); // global var name -> interface name

for (const sf of program.getSourceFiles()) {
  if (!/[\\/]lib\.[\w.]+\.d\.ts$/.test(sf.fileName)) continue;
  const lib = /lib\.([\w.]+)\.d\.ts$/.exec(sf.fileName)[1];
  for (const st of sf.statements) {
    if (ts.isInterfaceDeclaration(st)) {
      const n = st.name.text;
      if (!interfaces.has(n)) interfaces.set(n, []);
      interfaces.get(n).push({ decl: st, lib });
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.type) continue;
        if (ts.isTypeReferenceNode(d.type) && ts.isIdentifier(d.type.typeName))
          varTypes.set(d.name.text, d.type.typeName.text);
      }
    }
  }
}

const PROTO_OF = new Map(); // interface name -> global name whose .prototype it is
for (const [globalName, ctorIface] of varTypes) {
  // ArrayConstructor's `prototype: Array<any>` tells us Array is the instance side
  for (const { decl } of interfaces.get(ctorIface) ?? []) {
    for (const m of decl.members) {
      if (
        ts.isPropertySignature(m) &&
        m.name &&
        ts.isIdentifier(m.name) &&
        m.name.text === "prototype" &&
        m.type
      ) {
        const t = m.type;
        // `readonly prototype: Foo` — or `any[]`, which is Array's instance side
        const nm = ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName)
          ? t.typeName.text
          : ts.isArrayTypeNode(t)
            ? "Array"
            : null;
        if (nm) PROTO_OF.set(nm, globalName);
      }
    }
  }
}

const paramInfo = (p) => ({
  name: ts.isIdentifier(p.name) ? p.name.text : "<pattern>",
  type: p.type ? p.type.getText() : "any",
  optional: !!p.questionToken || !!p.dotDotDotToken,
  rest: !!p.dotDotDotToken,
  callable:
    !!p.type &&
    (ts.isFunctionTypeNode(p.type) ||
      /=>/.test(p.type.getText()) ||
      /^(Function)$/.test(p.type.getText())),
});

const members = [];
const push = (owner, lib, m, isStatic) => {
  // call / construct signatures are the constructor itself: spec clause "Object", "Error", …
  if (!m.name) {
    if (ts.isCallSignatureDeclaration(m) || ts.isConstructSignatureDeclaration(m))
      members.push({
        key: owner,
        owner,
        name: owner,
        static: true,
        kind: ts.isConstructSignatureDeclaration(m) ? "construct" : "call",
        lib,
        params: (m.parameters ?? []).map(paramInfo),
        text: m.getText().replace(/\s+/g, " ").slice(0, 200),
      });
    return;
  }
  const name = ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)
    ? m.name.text
    : ts.isComputedPropertyName(m.name)
      ? // [Symbol.iterator] → spec's "[ %Symbol.iterator% ]"
        `[ %${m.name.expression.getText()}% ]`
      : null;
  if (!name) return;
  const kind = ts.isMethodSignature(m)
    ? "method"
    : ts.isPropertySignature(m)
      ? "property"
      : ts.isConstructSignatureDeclaration(m)
        ? "construct"
        : ts.isCallSignatureDeclaration(m)
          ? "call"
          : ts.isGetAccessor(m)
            ? "getter"
            : "other";
  const sep = name.startsWith("[") ? " " : ".";
  members.push({
    key: isStatic ? `${owner}${sep}${name}` : `${owner}.prototype${sep}${name}`,
    owner,
    name,
    static: isStatic,
    kind,
    lib,
    params:
      ts.isMethodSignature(m) || ts.isCallSignatureDeclaration(m) || ts.isConstructSignatureDeclaration(m)
        ? (m.parameters ?? []).map(paramInfo)
        : null,
    text: m.getText().replace(/\s+/g, " ").slice(0, 200),
  });
};

const varByIface = new Map();
for (const [g, iface] of varTypes) if (!varByIface.has(iface)) varByIface.set(iface, g);

for (const [ifaceName, decls] of interfaces) {
  const instanceOf =
    PROTO_OF.get(ifaceName) ??
    // `interface Date` + `declare var Date: DateConstructor` — the interface *is* the instance side
    (varTypes.has(ifaceName) && varTypes.get(ifaceName) !== ifaceName ? ifaceName : null);
  const ctorFor = varByIface.get(ifaceName); // e.g. ArrayConstructor ← var Array
  // A namespace object (Math, JSON, Reflect) is its own type: `declare var Math: Math`.
  const isNamespace = ctorFor && ctorFor === ifaceName;
  for (const { decl, lib } of decls) {
    for (const m of decl.members) {
      if (isNamespace) push(ctorFor, lib, m, true);
      else if (instanceOf) push(instanceOf, lib, m, false);
      else if (ctorFor) push(ctorFor, lib, m, true);
    }
  }
}

// Top-level `declare function parseInt(...)` — global functions with bare spec names.
for (const sf of program.getSourceFiles()) {
  if (!/[\\/]lib\.[\w.]+\.d\.ts$/.test(sf.fileName)) continue;
  const lib = /lib\.([\w.]+)\.d\.ts$/.exec(sf.fileName)[1];
  for (const st of sf.statements) {
    if (!ts.isFunctionDeclaration(st) || !st.name) continue;
    members.push({
      key: st.name.text,
      owner: "globalThis",
      name: st.name.text,
      static: true,
      kind: "method",
      lib,
      params: (st.parameters ?? []).map(paramInfo),
      text: st.getText().replace(/\s+/g, " ").slice(0, 200),
    });
  }
}

// De-dup overloads: one entry per key, merging libs.
const byKey = new Map();
for (const m of members) {
  const cur = byKey.get(m.key);
  if (!cur) byKey.set(m.key, { ...m, libs: [m.lib], overloads: 1 });
  else {
    cur.overloads++;
    if (!cur.libs.includes(m.lib)) cur.libs.push(m.lib);
  }
}

const out = [...byKey.values()].map(({ lib, ...m }) => m);
mkdirSync(new URL("./out/", import.meta.url), { recursive: true });
writeFileSync(new URL(OUT, import.meta.url), JSON.stringify(out, null, 2));

const byLib = {};
for (const m of out) for (const l of m.libs) byLib[l] = (byLib[l] ?? 0) + 1;
console.log(`members: ${out.length}`);
console.log(
  `  static: ${out.filter((m) => m.static).length}  prototype: ${out.filter((m) => !m.static).length}`,
);
console.log(`  callable-param members: ${out.filter((m) => m.params?.some((p) => p.callable)).length}`);
console.log(
  "top libs:",
  Object.entries(byLib)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10),
);

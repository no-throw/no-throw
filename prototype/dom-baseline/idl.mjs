// PROTOTYPE — throwaway (#26). What does curated WebIDL know about throwing?
import * as idl from '@webref/idl';
import fs from 'node:fs';

const parsedBySpec = await idl.parseAll();

const members = []; // one row per IDL member
const extAttrTally = Object.create(null);
const callbackNames = new Set();
const enumNames = new Set();
const dictionaries = new Map();
const interfaces = new Map();
const typedefs = new Map();

const tally = (t, k) => (t[k] = (t[k] ?? 0) + 1);

// pass 1 — collect type kinds so argument types can be classified
for (const [spec, tree] of Object.entries(parsedBySpec)) {
  for (const def of tree) {
    if (def.type === 'callback' || def.type === 'callback interface') callbackNames.add(def.name);
    else if (def.type === 'enum') enumNames.add(def.name);
    else if (def.type === 'dictionary') dictionaries.set(def.name, def);
    else if (def.type === 'typedef') typedefs.set(def.name, def);
    else if (def.type === 'interface' || def.type === 'namespace') {
      if (!interfaces.has(def.name)) interfaces.set(def.name, { spec, partials: [], def: null });
      const e = interfaces.get(def.name);
      if (def.partial) e.partials.push(def);
      else (e.def = def), (e.spec = spec);
    }
  }
}

// mixin members are flattened into their host interfaces by lib.dom.d.ts
const includes = [];
for (const tree of Object.values(parsedBySpec))
  for (const def of tree) if (def.type === 'includes') includes.push({ host: def.target, mixin: def.includes });

const resolveTypedef = (name, depth = 0) => {
  if (depth > 5 || !typedefs.has(name)) return name;
  const t = typedefs.get(name).idlType;
  return typeof t.idlType === 'string' ? resolveTypedef(t.idlType, depth + 1) : name;
};

const flattenType = (t, out = []) => {
  if (!t) return out;
  if (Array.isArray(t.idlType)) t.idlType.forEach((s) => flattenType(s, out));
  else if (typeof t.idlType === 'string') out.push(resolveTypedef(t.idlType));
  else if (t.idlType) flattenType(t.idlType, out);
  return out;
};

const extAttrsOf = (node) => (node.extAttrs ?? []).map((e) => e.name);

// pass 2 — the member inventory
for (const [spec, tree] of Object.entries(parsedBySpec)) {
  for (const def of tree) {
    if (def.type !== 'interface' && def.type !== 'namespace' && def.type !== 'interface mixin') continue;
    const owner = def.name;
    for (const mem of def.members ?? []) {
      const row = { spec, owner, partial: !!def.partial, mixin: def.type === 'interface mixin' };
      for (const e of extAttrsOf(mem)) tally(extAttrTally, e);
      if (mem.type === 'operation' && mem.name) {
        row.kind = 'method';
        row.name = mem.name;
        row.static = mem.special === 'static';
        row.extAttrs = extAttrsOf(mem);
        row.args = (mem.arguments ?? []).map((a) => ({
          name: a.name,
          types: flattenType(a.idlType),
          extAttrs: extAttrsOf(a),
          optional: a.optional,
          variadic: a.variadic,
        }));
      } else if (mem.type === 'attribute') {
        row.kind = 'attribute';
        row.name = mem.name;
        row.readonly = !!mem.readonly;
        row.static = mem.special === 'static';
        row.extAttrs = extAttrsOf(mem);
        row.types = flattenType(mem.idlType);
      } else if (mem.type === 'constructor') {
        row.kind = 'constructor';
        row.name = 'constructor';
        row.extAttrs = extAttrsOf(mem);
        row.args = (mem.arguments ?? []).map((a) => ({
          name: a.name,
          types: flattenType(a.idlType),
          extAttrs: extAttrsOf(a),
          optional: a.optional,
        }));
      } else if (mem.type === 'const') {
        row.kind = 'const';
        row.name = mem.name;
      } else continue;
      members.push(row);
    }
  }
}

// --- structural hazards visible in IDL alone -------------------------------
// The binding layer throws on: [EnforceRange] out-of-range, enum conversion of an
// unknown string, missing required dictionary members, overload resolution, and
// interface-type brand checks. Which of those survive a *declared TypeScript type*?
const argTypeClass = (a) => {
  const cls = new Set();
  for (const e of a.extAttrs ?? []) if (e === 'EnforceRange' || e === 'Clamp') cls.add(e);
  for (const t of a.types ?? []) {
    if (callbackNames.has(t)) cls.add('callback');
    else if (enumNames.has(t)) cls.add('enum');
    else if (dictionaries.has(t)) cls.add('dictionary');
    else if (t === 'any' || t === 'object') cls.add('any');
  }
  return [...cls];
};

const structural = Object.create(null);
for (const m of members) {
  const classes = new Set();
  for (const a of m.args ?? []) for (const c of argTypeClass(a)) classes.add(c);
  m.structural = [...classes];
  for (const c of m.structural) tally(structural, c);
}

const enforceRange = members.filter((m) => m.structural.includes('EnforceRange'));
const withCallback = members.filter((m) => m.structural.includes('callback'));

fs.mkdirSync('out', { recursive: true });
fs.writeFileSync('out/idl-members.json', JSON.stringify(members, null, 1));
fs.writeFileSync('out/idl-includes.json', JSON.stringify(includes, null, 1));
fs.writeFileSync('out/idl-dictionaries.json', JSON.stringify([...dictionaries.keys()], null, 1));

const byKind = Object.create(null);
for (const m of members) tally(byKind, m.kind);

console.log('specs with IDL:', Object.keys(parsedBySpec).length);
console.log('IDL members:', members.length, byKind);
console.log('interfaces:', interfaces.size, 'callbacks:', callbackNames.size, 'enums:', enumNames.size, 'dicts:', dictionaries.size);
console.log('\nstructural arg classes:', structural);
console.log('[EnforceRange] members:', enforceRange.length);
console.log('callback-taking members:', withCallback.length);

const throwish = Object.entries(extAttrTally)
  .filter(([k]) => /throw|error|exception|fail/i.test(k))
  .sort((a, b) => b[1] - a[1]);
console.log('\nextended attributes mentioning throw/error/exception:', throwish.length ? throwish : 'NONE');
console.log('\ntop 25 extended attributes overall:');
console.log(
  Object.entries(extAttrTally)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([k, v]) => `  ${String(v).padStart(5)}  ${k}`)
    .join('\n'),
);

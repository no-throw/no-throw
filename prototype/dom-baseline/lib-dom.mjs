// PROTOTYPE — throwaway (#26). Inventory of lib.dom.d.ts's colourable surface.
// Mirrors ../stdlib-baseline/lib-members.mjs, but for the DOM libs.
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tsLib = path.dirname(
  require.resolve('typescript/lib/typescript.js', {
    paths: [path.resolve('../node_modules/.pnpm/typescript@5.9.3/node_modules')],
  }),
);

const LIBS = ['lib.dom.d.ts', 'lib.dom.iterable.d.ts', 'lib.dom.asynciterable.d.ts'];

const members = [];
const seen = new Set();
const add = (m) => {
  const key = `${m.owner}.${m.name}#${m.kind}`;
  if (seen.has(key)) return;
  seen.add(key);
  members.push(m);
};

const typeText = (node, sf) => (node ? node.getText(sf) : undefined);

for (const lib of LIBS) {
  const file = path.join(tsLib, lib);
  const sf = ts.createSourceFile(lib, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true);

  const collectMembers = (owner, list) => {
    for (const mem of list) {
      const nameNode = mem.name;
      const name = nameNode
        ? ts.isComputedPropertyName(nameNode)
          ? nameNode.getText(sf)
          : nameNode.getText(sf).replace(/^["']|["']$/g, '')
        : undefined;
      if (ts.isMethodSignature(mem) || ts.isMethodDeclaration(mem)) {
        add({
          owner,
          name,
          kind: 'method',
          lib,
          params: mem.parameters.map((p) => ({
            name: p.name.getText(sf),
            type: typeText(p.type, sf),
            optional: !!p.questionToken || !!p.dotDotDotToken,
            rest: !!p.dotDotDotToken,
          })),
          returns: typeText(mem.type, sf),
        });
      } else if (ts.isPropertySignature(mem) || ts.isPropertyDeclaration(mem)) {
        add({
          owner,
          name,
          kind: 'property',
          lib,
          readonly: !!mem.modifiers?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword),
          type: typeText(mem.type, sf),
          isFunctionTyped: !!mem.type && (ts.isFunctionTypeNode(mem.type) || /=>/.test(typeText(mem.type, sf) ?? '')),
        });
      } else if (ts.isGetAccessor(mem) || ts.isSetAccessor(mem)) {
        add({ owner, name, kind: 'accessor', lib, type: typeText(mem.type, sf) });
      } else if (ts.isConstructSignatureDeclaration(mem)) {
        add({
          owner,
          name: 'constructor',
          kind: 'constructor',
          lib,
          params: mem.parameters.map((p) => ({
            name: p.name.getText(sf),
            type: typeText(p.type, sf),
            optional: !!p.questionToken || !!p.dotDotDotToken,
          })),
        });
      } else if (ts.isCallSignatureDeclaration(mem)) {
        add({ owner, name: 'call', kind: 'callsig', lib });
      } else if (ts.isIndexSignatureDeclaration(mem)) {
        add({ owner, name: 'index', kind: 'index', lib });
      }
    }
  };

  sf.forEachChild((node) => {
    if (ts.isInterfaceDeclaration(node)) {
      collectMembers(node.name.text, node.members);
    } else if (ts.isVariableStatement(node)) {
      // `declare var Foo: { prototype: Foo; new(...): Foo; ... }` — the constructor object
      for (const decl of node.declarationList.declarations) {
        const owner = decl.name.getText(sf);
        if (decl.type && ts.isTypeLiteralNode(decl.type)) {
          collectMembers(`${owner}[[ctor]]`, decl.type.members);
        } else {
          add({ owner: '[[global]]', name: owner, kind: 'globalvar', lib, type: typeText(decl.type, sf) });
        }
      }
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      add({
        owner: '[[global]]',
        name: node.name.text,
        kind: 'globalfn',
        lib,
        params: node.parameters.map((p) => ({ name: p.name.getText(sf), type: typeText(p.type, sf) })),
        returns: typeText(node.type, sf),
      });
    }
  });
}

const byKind = Object.create(null); // literal `{}` collides on kind === 'constructor'
for (const m of members) byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;

fs.mkdirSync('out', { recursive: true });
fs.writeFileSync('out/lib-dom-members.json', JSON.stringify(members, null, 1));
console.log('lib.dom members:', members.length, byKind);

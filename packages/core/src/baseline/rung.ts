import ts from "typescript";

import type { CarrierAnswer, CarrierRung } from "../carrier/chain.js";
import { baselineCoversOwner, lookupBaselineEntry } from "./data.js";
import {
  libTargetOfFileName,
  memberKey,
  staticMemberKey,
  symbolMemberName,
} from "./keys.js";

/**
 * The baseline, as one more rung of the resolver chain and nothing else. It
 * sits below everything anybody published and above the floor, so a lib member
 * somebody has an opinion about is answered by that opinion first.
 *
 * Activation needs no `lib` setting to read: a declaration is baseline material
 * exactly when it was written in a `lib.*.d.ts` the program loaded, so a project
 * without `dom` in its `lib` resolves nothing there and gets no DOM colors. The
 * same reading keeps `@types/node` out — it is a real npm package, served by the
 * overlay channel, and its files are not lib files.
 *
 * A member with no entry is not answered here at all, which is the drift
 * guarantee stated as behavior: a TypeScript release landing ahead of a
 * `@nothrow/core` release floors its newcomers by construction.
 */
export const baselineRung: CarrierRung = (query): CarrierAnswer | undefined => {
  const { declaration } = query;
  const libTarget = libTargetOfFileName(declaration.getSourceFile().fileName);
  if (libTarget === undefined) return undefined;

  const key = baselineKeyOf(declaration);
  if (key === undefined) return undefined;

  const entry = lookupBaselineEntry(libTarget, key);
  return entry === undefined ? undefined : { kind: "entry", entry };
};

/**
 * Whether the baseline enumerates the type this declaration is written on, and
 * so whether it was owed an answer about the member at all. What absence means
 * turns on this: inside the enumeration it is a floor, outside it the
 * declaration answers like any other hand-written one.
 */
export function baselineEnumerates(declaration: ts.Declaration): boolean {
  const libTarget = libTargetOfFileName(declaration.getSourceFile().fileName);
  if (libTarget === undefined) return false;
  const owner = ownerOf(declaration);
  return owner !== undefined && baselineCoversOwner(libTarget, owner);
}

/** The type a member is written on, named the way the keys name it. */
function ownerOf(declaration: ts.Declaration): string | undefined {
  const owner = declaration.parent;
  if (ts.isInterfaceDeclaration(owner)) return owner.name.text;
  if (!ts.isTypeLiteralNode(owner)) return undefined;
  const variable = owner.parent;
  return ts.isVariableDeclaration(variable) && ts.isIdentifier(variable.name)
    ? variable.name.text
    : undefined;
}

/**
 * The key a lib declaration is filed under. The generators read it off the
 * declaration and so does this, which is what keeps the two in step without a
 * name convention: the declaring interface — or the `declare var` whose type
 * literal holds the static side — and the member's own name.
 */
function baselineKeyOf(declaration: ts.Declaration): string | undefined {
  const name = memberNameOf(declaration);
  const owner = declaration.parent;

  if (ts.isInterfaceDeclaration(owner)) {
    return name === undefined
      ? undefined
      : memberKey(owner.name.text, name);
  }

  // `declare var Element: { prototype: Element; new(): Element }` — the DOM
  // libs' spelling of a constructor object, where the variable's name is the
  // only thing a resolver can read.
  if (ts.isTypeLiteralNode(owner)) {
    const variable = owner.parent;
    if (
      name === undefined ||
      !ts.isVariableDeclaration(variable) ||
      !ts.isIdentifier(variable.name)
    ) {
      return undefined;
    }
    return staticMemberKey(variable.name.text, name);
  }

  // `declare function parseInt(…)`, `declare function setTimeout(…)`: a global
  // with no owner at all.
  return ts.isFunctionDeclaration(declaration) && declaration.name !== undefined
    ? declaration.name.text
    : undefined;
}

/** `push`, `@@iterator`, `()` for a call signature, `new` for a construct one. */
function memberNameOf(declaration: ts.Declaration): string | undefined {
  if (ts.isCallSignatureDeclaration(declaration)) return "()";
  if (ts.isConstructSignatureDeclaration(declaration)) return "new";

  const nameNode = ts.getNameOfDeclaration(declaration);
  if (nameNode === undefined) return undefined;
  if (ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode)) {
    return nameNode.text;
  }
  return ts.isComputedPropertyName(nameNode)
    ? symbolMemberName(nameNode.getText())
    : undefined;
}

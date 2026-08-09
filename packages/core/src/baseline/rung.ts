import ts from "typescript";

import type { CarrierAnswer, CarrierRung } from "../carrier/chain.js";
import type { FloorSource } from "../colors.js";
import {
  baselineCoversOwner,
  lookupBaselineEntry,
  sourceOfLibTarget,
} from "./data.js";
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
 * `@no-throw/core` release floors its newcomers by construction.
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
 * Whether the chain came back with a color for the declaration, which is only
 * ever a question about a lib member: everywhere else the answer changes
 * nothing a message says.
 */
export type Stated = "stated" | "unstated";

/**
 * Which outs a floor over this declaration can honestly name, and whether a
 * mechanical bridge may be offered for it.
 *
 * A lib member is the baseline's alone — every other rung is keyed by npm
 * package name, and no key in that grammar reaches one — so the question is
 * first where the declaration was written, and then, once it turns out to be a
 * lib member, whether the baseline stated a color for it. That second half is
 * what decides the offer: a bridge over a color somebody wrote down after
 * fuzzing it is honest, and one over a member the baseline is silent about
 * would be a one-click offer to swallow a throw nobody proved.
 */
export function floorSourceOf(
  declaration: ts.Declaration,
  stated: Stated,
): FloorSource {
  const libTarget = libTargetOfFileName(declaration.getSourceFile().fileName);
  if (libTarget === undefined) return PACKAGE_SOURCE;
  return {
    reach: "lib",
    baseline: sourceOfLibTarget(libTarget),
    stated: stated === "stated",
  };
}

/** The answer for everything that is not a lib member, which is most of it. */
export const PACKAGE_SOURCE: FloorSource = { reach: "package" };

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
  return owner !== undefined && baselineCoversOwner(libTarget, owner.name);
}

/**
 * The type a member is written on, and how the keys join the two. An interface
 * is the instance side and joins with `#`; a `declare var`'s type literal is a
 * constructor object — the DOM libs' spelling of one — and joins with `.`.
 */
function ownerOf(
  declaration: ts.Declaration,
): { name: string; join: (owner: string, member: string) => string } | undefined {
  const owner = declaration.parent;
  if (ts.isInterfaceDeclaration(owner)) {
    return { name: owner.name.text, join: memberKey };
  }
  if (!ts.isTypeLiteralNode(owner)) return undefined;

  const variable = owner.parent;
  return ts.isVariableDeclaration(variable) && ts.isIdentifier(variable.name)
    ? { name: variable.name.text, join: staticMemberKey }
    : undefined;
}

/**
 * The key a lib declaration is filed under. The generators read it off the
 * declaration and so does this, which is what keeps the two in step without a
 * name convention: the declaring interface — or the `declare var` whose type
 * literal holds the static side — and the member's own name.
 */
function baselineKeyOf(declaration: ts.Declaration): string | undefined {
  const owner = ownerOf(declaration);
  if (owner === undefined) {
    // `declare function parseInt(…)`, `declare function setTimeout(…)`: a
    // global with no owner at all.
    return ts.isFunctionDeclaration(declaration) &&
      declaration.name !== undefined
      ? declaration.name.text
      : undefined;
  }

  const name = memberNameOf(declaration);
  return name === undefined ? undefined : owner.join(owner.name, name);
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

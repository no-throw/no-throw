import type ts from "typescript";

import type { LibParam, MemberKind } from "./inventory.js";
import { libTargetOfFileName, memberKey, staticMemberKey, symbolMemberName } from "./keys.js";
import type { LibProgram } from "./program.js";

/**
 * `lib.dom.d.ts` is shaped nothing like the ES libs, which is why it needs its
 * own walk rather than a widened one. There, a global names a constructor
 * *interface* (`declare var Array: ArrayConstructor`) and every member lives in
 * a named interface. Here the constructor object is an anonymous type literal
 * (`declare var Element: { prototype: Element; new(): Element }`), instance
 * members live in interfaces the globals never mention, and a third of the
 * surface arrives through `extends` mixins (`ARIAMixin`, `GlobalEventHandlers`)
 * that have no runtime object at all.
 */
export interface DomMember {
  /** `Element#setAttribute`, `Response.json`, `fetch`. */
  readonly key: string;
  /** The interface or `declare var` the member is written in. */
  readonly owner: string;
  readonly name: string;
  readonly kind: MemberKind;
  readonly isStatic: boolean;
  /** Lib targets whose `.d.ts` declares it: `dom`, `dom.iterable`. */
  readonly libs: readonly string[];
  readonly receiverType: ts.Type | undefined;
  readonly params: readonly LibParam[] | undefined;
  /** The `.d.ts` itself spells it `get`/`set`. True for 24 of 2,576 attributes. */
  readonly declaredAccessor: boolean;
  readonly readonlyModifier: boolean;
  /** Dotted path for a report: `Element.prototype.setAttribute`. */
  readonly runtimePath: string;
}

export interface DomInventory {
  readonly members: readonly DomMember[];
  /**
   * Interface name → itself plus every interface that transitively extends it.
   * A mixin has no constructor to reach, so a probe for `ARIAMixin#ariaLabel`
   * has to find some `Element` instead — without this the mixins, which is
   * where a large part of the surface lives, would all be unprobed.
   */
  readonly implementers: ReadonlyMap<string, readonly string[]>;
  /**
   * Interface name → every interface it transitively extends, nearest first.
   * `lib.dom.d.ts` redeclares inherited members to narrow their types —
   * `Element` restates `addEventListener` for its typed event map — and the
   * redeclaration shadows the base at every call site. WebIDL forbids an
   * interface from redeclaring a superinterface's operation, so the base's
   * definition *is* the definition of the redeclared one.
   */
  readonly bases: ReadonlyMap<string, readonly string[]>;
  /** Interfaces reachable as `declare var X: { prototype: X, … }`. */
  readonly constructed: ReadonlySet<string>;
}

interface MutableMember {
  readonly key: string;
  readonly owner: string;
  readonly name: string;
  kind: MemberKind;
  readonly isStatic: boolean;
  readonly libs: string[];
  readonly receiverType: ts.Type | undefined;
  params: MutableParam[] | undefined;
  declaredAccessor: boolean;
  readonlyModifier: boolean;
  readonly runtimePath: string;
}

interface MutableParam {
  name: string;
  readonly types: ts.Type[];
  optional: boolean;
  rest: boolean;
}

export function collectDomMembers({
  ts: tsApi,
  program,
  checker,
}: LibProgram): DomInventory {
  const files = program
    .getSourceFiles()
    .filter((file) => libTargetOfFileName(file.fileName)?.startsWith("dom") === true);

  const declaredTypeOf = (name: ts.Identifier): ts.Type | undefined => {
    const symbol = checker.getSymbolAtLocation(name);
    return symbol === undefined ? undefined : checker.getDeclaredTypeOfSymbol(symbol);
  };

  const drafts = new Map<string, MutableMember>();
  const extendedBy = new Map<string, Set<string>>();
  const extend = new Map<string, readonly string[]>();
  const constructed = new Set<string>();

  for (const file of files) {
    const lib = libTargetOfFileName(file.fileName);
    if (lib === undefined) continue;

    for (const statement of file.statements) {
      if (tsApi.isInterfaceDeclaration(statement)) {
        const owner = statement.name.text;
        const bases = baseNames(tsApi, statement);
        for (const base of bases) {
          (extendedBy.get(base) ?? setIn(extendedBy, base)).add(owner);
        }
        extend.set(owner, [...(extend.get(owner) ?? []), ...bases]);
        const receiver = declaredTypeOf(statement.name);
        for (const member of statement.members) {
          add(drafts, tsApi, checker, lib, {
            owner,
            isStatic: false,
            receiverType: receiver,
            holder: `${owner}.prototype`,
            member,
          });
        }
        continue;
      }

      if (tsApi.isFunctionDeclaration(statement) && statement.name !== undefined) {
        addGlobalFunction(drafts, tsApi, checker, lib, statement.name.text, statement);
        continue;
      }

      if (!tsApi.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        const typeNode = declaration.type;
        if (
          !tsApi.isIdentifier(declaration.name) ||
          typeNode === undefined ||
          !tsApi.isTypeLiteralNode(typeNode)
        ) {
          // `declare var document: Document` is a binding, not a member access:
          // reading the identifier transfers control nowhere. `window.document`
          // is covered by `Window#document`, where it is really declared.
          continue;
        }
        const owner = declaration.name.text;
        if (typeNode.members.some((member) => isPrototypeSlot(tsApi, member))) {
          constructed.add(owner);
        }
        const receiver = checker.getTypeAtLocation(declaration);
        for (const member of typeNode.members) {
          if (isPrototypeSlot(tsApi, member)) continue;
          add(drafts, tsApi, checker, lib, {
            owner,
            isStatic: true,
            receiverType: receiver,
            holder: owner,
            member,
          });
        }
      }
    }
  }

  return {
    members: [...drafts.values()]
      .map(finish)
      .sort((left, right) => left.key.localeCompare(right.key)),
    implementers: closeOver(extendedBy),
    bases: closeOverBases(extend),
    constructed,
  };
}

function setIn(map: Map<string, Set<string>>, key: string): Set<string> {
  const created = new Set<string>();
  map.set(key, created);
  return created;
}

function baseNames(
  tsApi: typeof ts,
  declaration: ts.InterfaceDeclaration,
): readonly string[] {
  const names: string[] = [];
  for (const clause of declaration.heritageClauses ?? []) {
    for (const type of clause.types) {
      if (tsApi.isIdentifier(type.expression)) names.push(type.expression.text);
    }
  }
  return names;
}

/** `prototype: Element` carries no behavior; it is the link, not a member. */
function isPrototypeSlot(tsApi: typeof ts, member: ts.TypeElement): boolean {
  const name = member.name;
  return (
    name !== undefined && tsApi.isIdentifier(name) && name.text === "prototype"
  );
}

interface Slot {
  readonly owner: string;
  readonly isStatic: boolean;
  readonly receiverType: ts.Type | undefined;
  readonly holder: string;
  readonly member: ts.TypeElement;
}

function add(
  drafts: Map<string, MutableMember>,
  tsApi: typeof ts,
  checker: ts.TypeChecker,
  lib: string,
  slot: Slot,
): void {
  const drafted = draft(tsApi, slot);
  if (drafted === undefined) return;
  const { signature, ...rest } = drafted;
  let existing = drafts.get(drafted.key);
  if (existing === undefined) {
    existing = { ...rest, libs: [], params: signature === undefined ? undefined : [] };
    drafts.set(drafted.key, existing);
  }
  if (!existing.libs.includes(lib)) existing.libs.push(lib);
  // An interface merged across lib files may declare the same name as a method
  // in one and a property in another; a callable spelling wins, because that is
  // the shape a call site will meet.
  if (signature !== undefined && existing.params === undefined) {
    existing.params = [];
    existing.kind = drafted.kind;
  }
  if (drafted.declaredAccessor) existing.declaredAccessor = true;
  if (!drafted.readonlyModifier) existing.readonlyModifier = false;
  if (signature === undefined || existing.params === undefined) return;
  mergeParameters(tsApi, checker, existing.params, signature);
}

function addGlobalFunction(
  drafts: Map<string, MutableMember>,
  tsApi: typeof ts,
  checker: ts.TypeChecker,
  lib: string,
  name: string,
  declaration: ts.FunctionDeclaration,
): void {
  let existing = drafts.get(name);
  if (existing === undefined) {
    existing = {
      key: name,
      owner: "globalThis",
      name,
      kind: "function",
      isStatic: true,
      libs: [],
      receiverType: undefined,
      params: [],
      declaredAccessor: false,
      readonlyModifier: false,
      runtimePath: name,
    };
    drafts.set(name, existing);
  }
  if (!existing.libs.includes(lib)) existing.libs.push(lib);
  if (existing.params !== undefined) {
    mergeParameters(tsApi, checker, existing.params, declaration);
  }
}

function mergeParameters(
  tsApi: typeof ts,
  checker: ts.TypeChecker,
  params: MutableParam[],
  signature: ts.SignatureDeclaration,
): void {
  signature.parameters.forEach((parameter, index) => {
    let slot = params[index];
    if (slot === undefined) {
      slot = {
        name: tsApi.isIdentifier(parameter.name) ? parameter.name.text : `arg${index}`,
        types: [],
        optional: false,
        rest: false,
      };
      params.push(slot);
    }
    slot.types.push(checker.getTypeAtLocation(parameter));
    if (parameter.questionToken !== undefined) slot.optional = true;
    if (parameter.dotDotDotToken !== undefined) slot.rest = true;
  });
  // A position some overload does not declare may still be omitted at a call.
  for (let index = signature.parameters.length; index < params.length; index++) {
    const slot = params[index];
    if (slot !== undefined) slot.optional = true;
  }
}

interface Draft extends Omit<MutableMember, "libs" | "params"> {
  readonly signature: ts.SignatureDeclaration | undefined;
}

function draft(tsApi: typeof ts, slot: Slot): Draft | undefined {
  const { member, owner, isStatic } = slot;
  const shared = {
    owner,
    isStatic,
    receiverType: slot.receiverType,
    declaredAccessor: false,
    readonlyModifier: false,
  };

  if (tsApi.isConstructSignatureDeclaration(member)) {
    return {
      ...shared,
      key: staticMemberKey(owner, "new"),
      name: "new",
      kind: "construct",
      runtimePath: `new ${owner}`,
      signature: member,
    };
  }
  if (tsApi.isCallSignatureDeclaration(member)) {
    return {
      ...shared,
      key: staticMemberKey(owner, "()"),
      name: "()",
      kind: "call",
      runtimePath: owner,
      signature: member,
    };
  }
  // An index signature colors no named member; the dynamic-key rule joins the
  // named ones instead (#29 §6), so there is nothing to key here.
  if (tsApi.isIndexSignatureDeclaration(member)) return undefined;

  const nameNode = member.name;
  if (nameNode === undefined) return undefined;
  const name =
    tsApi.isIdentifier(nameNode) || tsApi.isStringLiteral(nameNode)
      ? nameNode.text
      : tsApi.isComputedPropertyName(nameNode)
        ? symbolMemberName(nameNode.getText())
        : undefined;
  if (name === undefined) return undefined;

  const isMethod = tsApi.isMethodSignature(member);
  const isAccessor =
    tsApi.isGetAccessorDeclaration(member) || tsApi.isSetAccessorDeclaration(member);
  const runtimeName = name.startsWith("@@")
    ? `[Symbol.${name.slice(2)}]`
    : `.${name}`;

  return {
    ...shared,
    key: isStatic ? staticMemberKey(owner, name) : memberKey(owner, name),
    name,
    kind: isMethod ? "method" : isAccessor ? "accessor" : "property",
    declaredAccessor: isAccessor,
    readonlyModifier: hasReadonly(tsApi, member),
    runtimePath: `${slot.holder}${runtimeName}`,
    signature: isMethod ? member : undefined,
  };
}

function hasReadonly(tsApi: typeof ts, member: ts.TypeElement): boolean {
  return (
    tsApi.canHaveModifiers(member) &&
    (tsApi.getModifiers(member) ?? []).some(
      (modifier) => modifier.kind === tsApi.SyntaxKind.ReadonlyKeyword,
    )
  );
}

function finish(member: MutableMember): DomMember {
  return {
    key: member.key,
    owner: member.owner,
    name: member.name,
    kind: member.kind,
    isStatic: member.isStatic,
    libs: [...member.libs].sort(),
    receiverType: member.receiverType,
    params: member.params,
    declaredAccessor: member.declaredAccessor,
    readonlyModifier: member.readonlyModifier,
    runtimePath: member.runtimePath,
  };
}

/**
 * Transitive closure of `extends` upward, nearest base first. The interface
 * itself is *not* included: the point is what to fall back to when its own
 * declaration answers nothing.
 */
function closeOverBases(
  extend: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, readonly string[]> {
  const closed = new Map<string, readonly string[]>();
  for (const name of extend.keys()) {
    const ordered: string[] = [];
    const reached = new Set<string>([name]);
    for (let queue = [...(extend.get(name) ?? [])]; queue.length > 0; ) {
      const next = queue.shift();
      if (next === undefined || reached.has(next)) continue;
      reached.add(next);
      ordered.push(next);
      queue = [...queue, ...(extend.get(next) ?? [])];
    }
    closed.set(name, ordered);
  }
  return closed;
}

/** Transitive closure of `extends`, each interface included in its own set. */
function closeOver(
  extendedBy: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<string, readonly string[]> {
  const closed = new Map<string, readonly string[]>();
  const names = new Set<string>([...extendedBy.keys()]);
  for (const derived of extendedBy.values()) {
    for (const name of derived) names.add(name);
  }

  for (const name of names) {
    const reached = new Set<string>([name]);
    const queue = [name];
    while (queue.length > 0) {
      const current = queue.pop();
      if (current === undefined) continue;
      for (const derived of extendedBy.get(current) ?? []) {
        if (reached.has(derived)) continue;
        reached.add(derived);
        queue.push(derived);
      }
    }
    closed.set(name, [...reached].sort());
  }
  return closed;
}

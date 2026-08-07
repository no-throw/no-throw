import type ts from "typescript";

import { libTargetOfFileName, memberKey, symbolMemberName } from "./keys.js";
import type { LibProgram } from "./program.js";

export type MemberKind =
  | "method"
  | "property"
  | "accessor"
  | "call"
  | "construct"
  | "function";

export interface LibParam {
  readonly name: string;
  /**
   * One type per overload that declares this position. An entry covers all
   * overloads — the implementation is what throws — so a hazard is discharged
   * only when the domain holds for every one of them.
   */
  readonly types: readonly ts.Type[];
  readonly optional: boolean;
  readonly rest: boolean;
}

export interface LibMember {
  /** `Array#push`, `ArrayConstructor#from`, `parseInt`. */
  readonly key: string;
  /** The ECMA-262 clause name: `Array.prototype.push`, `Object.keys`. */
  readonly specKey: string;
  /** Dotted runtime path, for the fuzz gate. */
  readonly runtimePath: string;
  /** The object the member lives on at runtime: `Array.prototype`, `Math`, `""`. */
  readonly holderPath: string;
  readonly owner: string;
  readonly name: string;
  readonly kind: MemberKind;
  readonly isStatic: boolean;
  /** Lib targets whose `.d.ts` declares the member. */
  readonly libs: readonly string[];
  readonly receiverType: ts.Type | undefined;
  /** The interface the receiver is an instance of (`Array`, `String`, `Math`). */
  readonly receiverOwner: string;
  readonly params: readonly LibParam[] | undefined;
  /** The `.d.ts` itself spells the member `get`/`set`. Rare in the ES libs. */
  readonly declaredAccessor: boolean;
}

interface Slot {
  readonly owner: string;
  readonly specOwner: string;
  readonly isStatic: boolean;
  readonly receiverType: ts.Type | undefined;
  readonly receiverOwner: string;
}

/**
 * Every member of TypeScript's ES libs that is reachable from a global — plus
 * the readonly mirrors (`ReadonlyArray`, `ReadonlyMap`, `ReadonlySet`), which
 * carry the same members under a name no global points at. Anything else has
 * no entry and therefore floors.
 */
export function collectLibMembers({
  ts: tsApi,
  program,
  checker,
}: LibProgram): readonly LibMember[] {
  const libFiles = program
    .getSourceFiles()
    .filter((file) => libTargetOfFileName(file.fileName) !== undefined);

  // `declare var Array: ArrayConstructor` — the only link from a global name to
  // the interfaces that describe it.
  const globalOfInterface = new Map<string, string>();
  for (const file of libFiles) {
    for (const statement of file.statements) {
      if (!tsApi.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!tsApi.isIdentifier(declaration.name)) continue;
        const typeNode = declaration.type;
        if (
          typeNode === undefined ||
          !tsApi.isTypeReferenceNode(typeNode) ||
          !tsApi.isIdentifier(typeNode.typeName)
        ) {
          continue;
        }
        const interfaceName = typeNode.typeName.text;
        if (!globalOfInterface.has(interfaceName)) {
          globalOfInterface.set(interfaceName, declaration.name.text);
        }
      }
    }
  }

  const interfaceSymbols = new Map<string, ts.Symbol>();
  for (const file of libFiles) {
    for (const statement of file.statements) {
      if (!tsApi.isInterfaceDeclaration(statement)) continue;
      const symbol = checker.getSymbolAtLocation(statement.name);
      if (symbol !== undefined && !interfaceSymbols.has(statement.name.text)) {
        interfaceSymbols.set(statement.name.text, symbol);
      }
    }
  }

  const declaredTypeOf = (name: string): ts.Type | undefined => {
    const symbol = interfaceSymbols.get(name);
    return symbol === undefined
      ? undefined
      : checker.getDeclaredTypeOfSymbol(symbol);
  };

  // `ArrayConstructor.prototype` is `any[]`, whose symbol is `Array` — that is
  // how the instance side of a global is identified without a name convention.
  const instanceOfGlobal = new Map<string, string>();
  for (const [ctorInterface, globalName] of globalOfInterface) {
    const ctorType = declaredTypeOf(ctorInterface);
    if (ctorType === undefined) continue;
    const prototype = checker.getPropertyOfType(ctorType, "prototype");
    const instanceName =
      prototype === undefined
        ? undefined
        : checker.getTypeOfSymbol(prototype).getSymbol()?.getName();
    if (instanceName !== undefined && interfaceSymbols.has(instanceName)) {
      instanceOfGlobal.set(instanceName, globalName);
    }
  }

  const slotOf = (interfaceName: string): Slot | undefined => {
    const instanceGlobal = instanceOfGlobal.get(interfaceName);
    if (instanceGlobal !== undefined) {
      return {
        owner: interfaceName,
        specOwner: `${instanceGlobal}.prototype`,
        isStatic: false,
        receiverType: declaredTypeOf(interfaceName),
        receiverOwner: interfaceName,
      };
    }
    const global = globalOfInterface.get(interfaceName);
    if (global !== undefined) {
      // A namespace object (`declare var Math: Math`) is its own type, so its
      // members are static even though the interface is the instance side.
      return {
        owner: interfaceName,
        specOwner: global,
        isStatic: true,
        receiverType: declaredTypeOf(interfaceName),
        receiverOwner: interfaceName,
      };
    }
    // `ReadonlyArray` carries `Array.prototype`'s members under a name no
    // global points at, so it would otherwise floor everywhere `readonly T[]`
    // is used.
    const mirrored = /^Readonly([A-Z]\w*)$/.exec(interfaceName)?.[1];
    const mirroredGlobal =
      mirrored === undefined ? undefined : instanceOfGlobal.get(mirrored);
    if (mirroredGlobal !== undefined) {
      return {
        owner: interfaceName,
        specOwner: `${mirroredGlobal}.prototype`,
        isStatic: false,
        receiverType: declaredTypeOf(interfaceName),
        receiverOwner: mirrored ?? interfaceName,
      };
    }
    return undefined;
  };

  const drafts = new Map<string, MutableMember>();

  for (const file of libFiles) {
    const lib = libTargetOfFileName(file.fileName);
    if (lib === undefined) continue;

    for (const statement of file.statements) {
      if (tsApi.isFunctionDeclaration(statement) && statement.name !== undefined) {
        addMember(drafts, tsApi, checker, lib, {
          key: statement.name.text,
          specKey: statement.name.text,
          runtimePath: statement.name.text,
          holderPath: "",
          owner: "globalThis",
          name: statement.name.text,
          kind: "function",
          isStatic: true,
          receiverType: undefined,
          receiverOwner: "globalThis",
          declaredAccessor: false,
          signatureNode: statement,
        });
        continue;
      }

      if (!tsApi.isInterfaceDeclaration(statement)) continue;
      const slot = slotOf(statement.name.text);
      if (slot === undefined) continue;

      for (const member of statement.members) {
        const drafted = draftMember(tsApi, slot, member);
        if (drafted === undefined) continue;
        addMember(drafts, tsApi, checker, lib, drafted);
      }
    }
  }

  return [...drafts.values()].map(finish);
}

interface Draft {
  readonly key: string;
  readonly specKey: string;
  readonly runtimePath: string;
  readonly holderPath: string;
  readonly owner: string;
  readonly name: string;
  readonly kind: MemberKind;
  readonly isStatic: boolean;
  readonly receiverType: ts.Type | undefined;
  readonly receiverOwner: string;
  readonly declaredAccessor: boolean;
  readonly signatureNode: ts.SignatureDeclaration | undefined;
}

interface MutableMember extends Omit<Draft, "signatureNode"> {
  readonly libs: string[];
  readonly params: MutableParam[] | undefined;
}

interface MutableParam {
  name: string;
  readonly types: ts.Type[];
  optional: boolean;
  rest: boolean;
}

function draftMember(
  tsApi: typeof ts,
  slot: Slot,
  member: ts.TypeElement,
): Draft | undefined {
  if (
    tsApi.isCallSignatureDeclaration(member) ||
    tsApi.isConstructSignatureDeclaration(member)
  ) {
    // A constructor interface's own call/construct signature *is* the global:
    // spec clause `Object ( . . . )`, runtime `Object`.
    const name = tsApi.isConstructSignatureDeclaration(member) ? "new" : "()";
    return {
      key: memberKey(slot.owner, name),
      specKey: slot.specOwner,
      runtimePath: slot.specOwner,
      holderPath: "",
      owner: slot.owner,
      name,
      kind: tsApi.isConstructSignatureDeclaration(member) ? "construct" : "call",
      isStatic: true,
      receiverType: slot.receiverType,
      receiverOwner: slot.receiverOwner,
      declaredAccessor: false,
      signatureNode: member,
    };
  }

  const nameNode = member.name;
  if (nameNode === undefined) return undefined;

  const raw =
    tsApi.isIdentifier(nameNode) || tsApi.isStringLiteral(nameNode)
      ? nameNode.text
      : tsApi.isComputedPropertyName(nameNode)
        ? symbolMemberName(nameNode.getText())
        : undefined;
  if (raw === undefined || raw === "prototype") return undefined;

  const isSymbolName = raw.startsWith("@@");
  const specName = isSymbolName
    ? ` [ %Symbol.${raw.slice(2)}% ]`
    : `.${raw}`;
  const runtimeName = isSymbolName ? `[Symbol.${raw.slice(2)}]` : `.${raw}`;

  const kind: MemberKind = tsApi.isMethodSignature(member)
    ? "method"
    : tsApi.isGetAccessorDeclaration(member) || tsApi.isSetAccessorDeclaration(member)
      ? "accessor"
      : "property";

  return {
    key: memberKey(slot.owner, raw),
    specKey: `${slot.specOwner}${specName}`,
    runtimePath: `${slot.specOwner}${runtimeName}`,
    holderPath: slot.specOwner,
    owner: slot.owner,
    name: raw,
    kind,
    isStatic: slot.isStatic,
    receiverType: slot.receiverType,
    receiverOwner: slot.receiverOwner,
    declaredAccessor: kind === "accessor",
    signatureNode: tsApi.isMethodSignature(member) ? member : undefined,
  };
}

function addMember(
  drafts: Map<string, MutableMember>,
  tsApi: typeof ts,
  checker: ts.TypeChecker,
  lib: string,
  draft: Draft,
): void {
  const { signatureNode, ...rest } = draft;
  let existing = drafts.get(draft.key);
  if (existing === undefined) {
    existing = {
      ...rest,
      libs: [],
      params: signatureNode === undefined ? undefined : [],
    };
    drafts.set(draft.key, existing);
  }
  if (!existing.libs.includes(lib)) existing.libs.push(lib);
  if (signatureNode === undefined || existing.params === undefined) return;

  signatureNode.parameters.forEach((parameter, index) => {
    let slot = existing.params?.[index];
    if (slot === undefined) {
      slot = {
        name: tsApi.isIdentifier(parameter.name)
          ? parameter.name.text
          : `arg${index}`,
        types: [],
        optional: false,
        rest: false,
      };
      existing.params?.push(slot);
    }
    slot.types.push(checker.getTypeAtLocation(parameter));
    // Optional in *any* overload means a call may omit it; rest likewise.
    if (parameter.questionToken !== undefined) slot.optional = true;
    if (parameter.dotDotDotToken !== undefined) slot.rest = true;
  });

  // A position some overload does not declare may still be omitted at a call.
  const declared = signatureNode.parameters.length;
  for (let index = declared; index < (existing.params?.length ?? 0); index++) {
    const slot = existing.params[index];
    if (slot !== undefined) slot.optional = true;
  }
}

function finish(member: MutableMember): LibMember {
  return {
    key: member.key,
    specKey: member.specKey,
    runtimePath: member.runtimePath,
    holderPath: member.holderPath,
    owner: member.owner,
    name: member.name,
    kind: member.kind,
    isStatic: member.isStatic,
    libs: member.libs,
    receiverType: member.receiverType,
    receiverOwner: member.receiverOwner,
    params: member.params,
    declaredAccessor: member.declaredAccessor,
  };
}

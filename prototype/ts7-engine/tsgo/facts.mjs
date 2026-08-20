/**
 * `TypeFacts` over a TypeScript 7 checker — the other half of driving the real
 * engine on tsgo, and the half the seam was built for.
 *
 * Three of the operations have no tsgo equivalent and are marked below. They
 * are the spike's upstream feedback: the API is curated rather than complete,
 * and these are the questions a type-aware linter asks that it cannot currently
 * answer.
 */
import {
  SignatureKind,
  SymbolFlags,
  TypeFlags,
} from "@typescript/native-preview/unstable/sync";

/** How the compiler spells a well-known-symbol member; see the port's note. */
const WELL_KNOWN_MEMBER = /^__@(\w+)@\d+$/u;

const OPAQUE = TypeFlags.Any | TypeFlags.Unknown;

const PRIMITIVE =
  TypeFlags.StringLike |
  TypeFlags.NumberLike |
  TypeFlags.BigIntLike |
  TypeFlags.BooleanLike |
  TypeFlags.ESSymbolLike |
  TypeFlags.Null |
  TypeFlags.Undefined |
  TypeFlags.Void |
  TypeFlags.Never;

/**
 * @param checker  a tsgo `Checker`
 * @param gaps     collects the names of missing operations the run reached,
 *                 rather than throwing, so one run reports every gap it hit
 */
export function tsgoFacts(checker, gaps = new Set()) {
  const missing = (name, fallback) => {
    gaps.add(name);
    return fallback;
  };

  /** A declaration handle resolved to the node the engine can read. */
  const node = (handle) => handle?.resolve();
  const nodes = (handles) =>
    (handles ?? []).map((handle) => handle.resolve()).filter(Boolean);

  const table = (map) => {
    const entries = new Map();
    for (const [name, symbol] of map ?? []) entries.set(String(name), symbol);
    return entries;
  };

  return {
    typeAt: (n) => checker.getTypeAtLocation(n),
    symbolAt: (n) => checker.getSymbolAtLocation(n),
    signatureAt: (n) => checker.getResolvedSignature(n),
    typeOfSymbolAt: (symbol, n) => checker.getTypeOfSymbolAtLocation(symbol, n),

    // GAP: no `getPropertySymbolOfDestructuringAssignment`. Returning nothing
    // is the sound direction — the site floors — so a run completes and the gap
    // shows up as lost precision rather than as a crash.
    destructuredProperty: () =>
      missing("destructuredProperty", undefined),

    apparentType: (type) => checker.getApparentType(type),

    // GAP: no `getAwaitedType`. Only reached while deciding whether an async
    // iterator's `next()` result is an `IteratorResult`, so absence costs
    // precision on async iteration and nothing else.
    awaitedType: () => missing("awaitedType", undefined),

    baseConstraintOf: (type) => checker.getBaseConstraintOfType(type),
    constituentsOf: (type) => (type.isUnionType() ? type.getTypes() : [type]),
    isUnion: (type) => type.isUnionType(),
    callSignaturesOf: (type) =>
      checker.getSignaturesOfType(type, SignatureKind.Call),
    propertyOfType: (type, name) => checker.getPropertyOfType(type, name),
    propertiesOfType: (type) => checker.getPropertiesOfType(type),
    wellKnownMember: (type, name) => {
      const prefix = `__@${name}@`;
      return checker
        .getPropertiesOfType(type)
        .find((property) => String(property.escapedName).startsWith(prefix));
    },
    symbolOfType: (type) => type.getSymbol(),
    stringLiteralValue: (type) =>
      type.isStringLiteralType() ? type.value : undefined,
    isOpaque: (type) => (type.flags & OPAQUE) !== 0,
    isPrimitive: (type) => (type.flags & PRIMITIVE) !== 0,

    typeOfSymbol: (symbol) => checker.getTypeOfSymbol(symbol),
    nameOf: (symbol) => symbol.name,
    wellKnownNameOf: (symbol) =>
      WELL_KNOWN_MEMBER.exec(String(symbol.escapedName))?.[1],
    valueDeclarationOf: (symbol) => node(symbol.valueDeclaration),
    declarationsOf: (symbol) => nodes(symbol.declarations),
    isAlias: (symbol) => (symbol.flags & SymbolFlags.Alias) !== 0,
    aliasedSymbol: (symbol) => checker.getAliasedSymbol(symbol),
    exportsOfModule: (symbol) => checker.getExportsOfModule(symbol),
    membersOfSymbol: (symbol) => table(symbol.getMembers()),
    exportsOfSymbol: (symbol) => table(symbol.getExports()),

    returnTypeOf: (signature) => checker.getReturnTypeOfSignature(signature),
    declarationOf: (signature) => signature.declaration?.resolve?.() ?? signature.declaration,
  };
}

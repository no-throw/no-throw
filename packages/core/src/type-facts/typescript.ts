import ts from "typescript";
import type {
  SignatureRef,
  SymbolRef,
  TypeFacts,
  TypeRef,
} from "../type-facts.js";

/** `any` and `unknown` say nothing about what runs, so they cannot be read. */
const OPAQUE_TYPE = ts.TypeFlags.Any | ts.TypeFlags.Unknown;

/** Types that run no user code when coerced. */
const PRIMITIVE_TYPE =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.ESSymbolLike |
  ts.TypeFlags.Null |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Void |
  ts.TypeFlags.Never;

/**
 * The in-process implementation: the host's own `TypeChecker`, which is the
 * configuration every consumer runs today. Types cross no boundary here, so
 * {@link TypeFacts.prime} has nothing to do — the batching the engine performs
 * for a wire-backed implementation costs it a walk it was going to do anyway.
 *
 * The casts are the whole price of the opaque refs, and they are all here.
 */
export function typeFactsOf(checker: ts.TypeChecker): TypeFacts {
  const type = (ref: TypeRef): ts.Type => ref as unknown as ts.Type;
  const symbol = (ref: SymbolRef): ts.Symbol => ref as unknown as ts.Symbol;
  const signature = (ref: SignatureRef): ts.Signature =>
    ref as unknown as ts.Signature;

  const asType = (value: ts.Type): TypeRef => value as unknown as TypeRef;
  const asSymbol = (value: ts.Symbol): SymbolRef =>
    value as unknown as SymbolRef;
  const asSignature = (value: ts.Signature): SignatureRef =>
    value as unknown as SignatureRef;

  /**
   * A symbol table as the port states it. `__String` is TypeScript's own
   * escaping of member names, and it is a string at runtime — the widening is
   * the only thing that happens here.
   */
  const table = (
    symbols: ts.SymbolTable | undefined,
  ): ReadonlyMap<string, SymbolRef> => {
    const entries = new Map<string, SymbolRef>();
    for (const [name, value] of symbols ?? []) {
      entries.set(String(name), asSymbol(value));
    }
    return entries;
  };

  const maybeType = (value: ts.Type | undefined): TypeRef | undefined =>
    value === undefined ? undefined : asType(value);
  const maybeSymbol = (value: ts.Symbol | undefined): SymbolRef | undefined =>
    value === undefined ? undefined : asSymbol(value);

  return {
    prime: () => undefined,

    typeAt: (node) => asType(checker.getTypeAtLocation(node)),
    symbolAt: (node) => maybeSymbol(checker.getSymbolAtLocation(node)),
    signatureAt: (node) => {
      const resolved = checker.getResolvedSignature(
        node as ts.CallLikeExpression,
      );
      return resolved === undefined ? undefined : asSignature(resolved);
    },
    typeOfSymbolAt: (target, node) =>
      asType(checker.getTypeOfSymbolAtLocation(symbol(target), node)),
    destructuredProperty: (name) =>
      maybeSymbol(
        checker.getPropertySymbolOfDestructuringAssignment(
          name as ts.Identifier,
        ),
      ),

    apparentType: (target) => asType(checker.getApparentType(type(target))),
    awaitedType: (target) => maybeType(checker.getAwaitedType(type(target))),
    baseConstraintOf: (target) =>
      maybeType(checker.getBaseConstraintOfType(type(target))),
    constituentsOf: (target) => {
      const value = type(target);
      return value.isUnion() ? value.types.map(asType) : [target];
    },
    isUnion: (target) => type(target).isUnion(),
    callSignaturesOf: (target) =>
      type(target).getCallSignatures().map(asSignature),
    propertyOfType: (target, name) =>
      maybeSymbol(checker.getPropertyOfType(type(target), name)),
    propertiesOfType: (target) =>
      checker.getPropertiesOfType(type(target)).map(asSymbol),
    wellKnownMember: (target, name) => {
      const prefix = `__@${name}@`;
      return maybeSymbol(
        checker
          .getPropertiesOfType(type(target))
          .find((property) => String(property.escapedName).startsWith(prefix)),
      );
    },
    symbolOfType: (target) => maybeSymbol(type(target).symbol),
    stringLiteralValue: (target) => {
      const value = type(target);
      return value.isStringLiteral() ? value.value : undefined;
    },
    isOpaque: (target) => (type(target).flags & OPAQUE_TYPE) !== 0,
    isPrimitive: (target) => (type(target).flags & PRIMITIVE_TYPE) !== 0,

    typeOfSymbol: (target) => asType(checker.getTypeOfSymbol(symbol(target))),
    nameOf: (target) => symbol(target).getName(),
    escapedNameOf: (target) => String(symbol(target).escapedName),
    valueDeclarationOf: (target) => symbol(target).valueDeclaration,
    declarationsOf: (target) => symbol(target).declarations ?? [],
    isAlias: (target) => (symbol(target).flags & ts.SymbolFlags.Alias) !== 0,
    aliasedSymbol: (target) => asSymbol(checker.getAliasedSymbol(symbol(target))),
    exportsOfModule: (target) =>
      checker.getExportsOfModule(symbol(target)).map(asSymbol),
    membersOfSymbol: (target) => table(symbol(target).members),
    exportsOfSymbol: (target) => table(symbol(target).exports),

    returnTypeOf: (target) => asType(signature(target).getReturnType()),
    declarationOf: (target) => signature(target).declaration,
  };
}

import type ts from "typescript";

/**
 * The seam between the engine and whatever answers type questions for it.
 *
 * The engine reaches the compiler in two ways, and they need different
 * treatment. Syntax it reads directly: `ts.Node` stays in these signatures
 * because the AST is materialized wherever the engine runs — under TypeScript 7
 * it is a client-side object graph that costs no round trip at all, so nothing
 * is bought by hiding it. Types are the opposite: under TS7 every one of these
 * questions crosses a process boundary, which is why they are gathered here
 * rather than scattered as `checker.` calls through nine files.
 *
 * {@link TypeRef}, {@link SymbolRef} and {@link SignatureRef} are opaque on
 * purpose. An implementation may hand back a `ts.Type`, a handle, or an index
 * into a table; the engine may only hand one back. Every question about one is
 * a method here — including the ones TypeScript answers as members, like
 * `type.isUnion()` — because a member read is exactly the kind of thing that
 * cannot cross a wire.
 *
 * The operations are named for what the engine wants to know rather than for
 * the `TypeChecker` method that happens to answer it, so an implementation that
 * has no such method can still be judged against the interface.
 */
export interface TypeFacts {
  typeAt(node: ts.Node): TypeRef;
  symbolAt(node: ts.Node): SymbolRef | undefined;
  /** The signature a call, `new` or tagged template actually resolves to. */
  signatureAt(node: ts.CallLikeExpression): SignatureRef | undefined;
  /**
   * The type a symbol has *at a site*, which a generic member only has there.
   */
  typeOfSymbolAt(symbol: SymbolRef, node: ts.Node): TypeRef;
  /** The property a destructuring assignment's target names. */
  destructuredProperty(name: ts.Identifier): SymbolRef | undefined;

  apparentType(type: TypeRef): TypeRef;
  /** What `await` on this type yields, where it is awaitable. */
  awaitedType(type: TypeRef): TypeRef | undefined;
  /** A type parameter's bound, where it has one. */
  baseConstraintOf(type: TypeRef): TypeRef | undefined;
  /** A union's members, or the type itself — the join the engine works over. */
  constituentsOf(type: TypeRef): readonly TypeRef[];
  /**
   * Whether the type is a union. Distinct from a one-element
   * {@link constituentsOf} because a member lookup treats the two differently:
   * a union's is joined over constituents' *apparent* types, a lone type's is
   * not, and reading "not a union" off a length would hide that.
   */
  isUnion(type: TypeRef): boolean;
  callSignaturesOf(type: TypeRef): readonly SignatureRef[];
  constructSignaturesOf(type: TypeRef): readonly SignatureRef[];
  propertyOfType(type: TypeRef, name: string): SymbolRef | undefined;
  propertiesOfType(type: TypeRef): readonly SymbolRef[];
  /**
   * A well-known-symbol member, by the name after the `@@`.
   *
   * TypeScript keys these `__@iterator@<id>` with an id belonging to that
   * program's `Symbol` declaration, so the name cannot be handed to
   * {@link propertyOfType} — it can only be matched. Asking for the match
   * rather than for the table is the difference between one question and one
   * per property: an iteration site over `readonly number[]` scans some forty
   * members to find one, and #81 measured that scan as 84% of every type
   * question a mark-dense project asks.
   */
  wellKnownMember(type: TypeRef, name: string): SymbolRef | undefined;
  symbolOfType(type: TypeRef): SymbolRef | undefined;
  /** The literal's text, or nothing where the type is not a string literal. */
  stringLiteralValue(type: TypeRef): string | undefined;
  /** `any` or `unknown`: a type that says nothing about what runs. */
  isOpaque(type: TypeRef): boolean;
  /**
   * Whether exactly one prototype stands behind the type, so that naming the
   * type names the declaration a member lookup lands on. Asked of one type at
   * a time: a union is exact only where every arm is, and that join is the
   * engine's to make.
   */
  isExact(type: TypeRef): boolean;
  /** Runs no user code when coerced. */
  isPrimitive(type: TypeRef): boolean;

  typeOfSymbol(symbol: SymbolRef): TypeRef;
  nameOf(symbol: SymbolRef): string;
  /**
   * The name after the `@@` where the symbol is a well-known-symbol member, and
   * nothing where it is an ordinary one. The compiler's spelling of these —
   * `__@toPrimitive@<id>`, with an id belonging to that program's `Symbol`
   * declaration — is the port's to know and nobody else's, which is why the
   * question is asked here rather than by matching a name.
   */
  wellKnownNameOf(symbol: SymbolRef): string | undefined;
  valueDeclarationOf(symbol: SymbolRef): ts.Declaration | undefined;
  declarationsOf(symbol: SymbolRef): readonly ts.Declaration[];
  isAlias(symbol: SymbolRef): boolean;
  aliasedSymbol(symbol: SymbolRef): SymbolRef;
  exportsOfModule(symbol: SymbolRef): readonly SymbolRef[];
  /**
   * The symbol's own tables, keyed as the compiler keys them. The export
   * surface walks both — a class's members and its statics are reached with
   * different punctuation but the same lookup.
   */
  membersOfSymbol(symbol: SymbolRef): ReadonlyMap<string, SymbolRef>;
  exportsOfSymbol(symbol: SymbolRef): ReadonlyMap<string, SymbolRef>;

  returnTypeOf(signature: SignatureRef): TypeRef;
  declarationOf(signature: SignatureRef): ts.Declaration | undefined;
}

/**
 * The declaration a name binds to. Two questions in sequence often enough to be
 * worth one name, and the pair is what "follow this identifier" means wherever
 * the engine does it.
 */
export function boundDeclaration(
  node: ts.Node,
  facts: TypeFacts,
): ts.Declaration | undefined {
  const symbol = facts.symbolAt(node);
  return symbol === undefined ? undefined : facts.valueDeclarationOf(symbol);
}

/** The declaration behind the signature a transfer resolves to, where there is one. */
export function resolvedDeclaration(
  node: ts.CallLikeExpression,
  facts: TypeFacts,
): ts.Declaration | undefined {
  const signature = facts.signatureAt(node);
  return signature === undefined ? undefined : facts.declarationOf(signature);
}

declare const REF: unique symbol;

/** A type, as far as the engine is concerned: something to hand back. */
export interface TypeRef {
  readonly [REF]: "type";
}

export interface SymbolRef {
  readonly [REF]: "symbol";
}

export interface SignatureRef {
  readonly [REF]: "signature";
}

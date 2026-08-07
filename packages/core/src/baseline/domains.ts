import type ts from "typescript";

import type { LibProgram } from "./program.js";

/**
 * What a declared type guarantees. A spec throw site is *type-excluded* when
 * the declared type of the value it is about makes the throw condition
 * unreachable — the judgment the baseline is made of, and the one thing a
 * standalone script cannot make, because it needs a checker to answer
 * questions like "what is `obj.length` given `obj: Array<T>`?".
 *
 * Every predicate is universal over the constituents of a union *and* over the
 * overloads that declare a position: one entry covers all overloads, so a
 * hazard is discharged only when every one of them discharges it.
 */
export class TypeDomains {
  readonly #ts: typeof ts;
  readonly #checker: ts.TypeChecker;

  constructor({ ts: tsApi, checker }: LibProgram) {
    this.#ts = tsApi;
    this.#checker = checker;
  }

  isCallable(types: readonly ts.Type[]): boolean {
    return this.#all(types, (type) => type.getCallSignatures().length > 0);
  }

  isConstructor(types: readonly ts.Type[]): boolean {
    return this.#all(
      types,
      (type) =>
        type.getConstructSignatures().length > 0 ||
        type.getCallSignatures().length > 0,
    );
  }

  isObject(types: readonly ts.Type[]): boolean {
    const { TypeFlags } = this.#ts;
    return this.#all(
      types,
      (type) => (type.flags & (TypeFlags.Object | TypeFlags.NonPrimitive)) !== 0,
    );
  }

  /**
   * The value carries no user code: its prototype is a builtin, and patching
   * `String.prototype` is trust base. So every object-shaped hazard —
   * accessors, `Symbol.species`, `toPrimitive`, invoked methods — is
   * unreachable on it.
   */
  isPrimitive(types: readonly ts.Type[]): boolean {
    const { TypeFlags } = this.#ts;
    const mask =
      TypeFlags.StringLike |
      TypeFlags.NumberLike |
      TypeFlags.BooleanLike |
      TypeFlags.BigIntLike |
      TypeFlags.ESSymbolLike |
      TypeFlags.Undefined |
      TypeFlags.Null |
      TypeFlags.Void;
    return this.#all(types, (type) => (type.flags & mask) !== 0);
  }

  /**
   * Safe to `ToNumber`/`ToString`/`ToPrimitive`: no Symbol, no BigInt, and no
   * object — an object reaches user code through `valueOf`/`toString`.
   */
  isCoercible(types: readonly ts.Type[]): boolean {
    const { TypeFlags } = this.#ts;
    const mask =
      TypeFlags.StringLike |
      TypeFlags.NumberLike |
      TypeFlags.BooleanLike |
      TypeFlags.Undefined |
      TypeFlags.Null |
      TypeFlags.Void;
    return this.#all(types, (type) => (type.flags & mask) !== 0);
  }

  isNonNullish(types: readonly ts.Type[]): boolean {
    const { TypeFlags } = this.#ts;
    const nullish = TypeFlags.Undefined | TypeFlags.Null | TypeFlags.Void;
    return this.#all(types, (type) => (type.flags & nullish) === 0);
  }

  isString(types: readonly ts.Type[]): boolean {
    const { TypeFlags } = this.#ts;
    return this.#all(types, (type) => (type.flags & TypeFlags.StringLike) !== 0);
  }

  isNumber(types: readonly ts.Type[]): boolean {
    const { TypeFlags } = this.#ts;
    return this.#all(types, (type) => (type.flags & TypeFlags.NumberLike) !== 0);
  }

  isSymbol(types: readonly ts.Type[]): boolean {
    const { TypeFlags } = this.#ts;
    return this.#all(
      types,
      (type) => (type.flags & TypeFlags.ESSymbolLike) !== 0,
    );
  }

  /** `readonly T[]`, `Array<T>`, `Iterable<T>` → `T`, where one exists. */
  elementTypeOf(type: ts.Type): ts.Type | undefined {
    const apparent = this.#apparent(type);
    const indexed = this.#checker.getIndexTypeOfType(
      apparent,
      this.#ts.IndexKind.Number,
    );
    if (indexed !== undefined) return indexed;
    const reference = apparent as ts.TypeReference;
    const args = this.#checker.getTypeArguments(reference);
    return args.length === 1 ? args[0] : undefined;
  }

  /**
   * Property-level type resolution — `obj.length` given `obj: Array<T>`. The
   * whole reason generation moved inside a live program.
   */
  propertyTypeOf(type: ts.Type, name: string): ts.Type | undefined {
    const property = this.#checker.getPropertyOfType(this.#apparent(type), name);
    return property === undefined
      ? undefined
      : this.#checker.getTypeOfSymbol(property);
  }

  /**
   * A well-known-symbol member by its `@@name` spelling. The checker escapes
   * these to `__@iterator@<id>`, so the lookup matches on the prefix.
   */
  symbolPropertyTypeOf(type: ts.Type, name: string): ts.Type | undefined {
    const prefix = `__@${name}`;
    for (const property of this.#apparent(type).getProperties()) {
      const escaped = property.escapedName as string;
      if (escaped === prefix || escaped.startsWith(`${prefix}@`)) {
        return this.#checker.getTypeOfSymbol(property);
      }
    }
    return undefined;
  }

  typeToString(type: ts.Type): string {
    return this.#checker.typeToString(type);
  }

  /** Every declared type, every union constituent, all resolved to apparent. */
  #all(
    types: readonly ts.Type[],
    predicate: (type: ts.Type) => boolean,
  ): boolean {
    if (types.length === 0) return false;
    const { TypeFlags } = this.#ts;
    for (const declared of types) {
      for (const constituent of this.#constituents(declared)) {
        if ((constituent.flags & (TypeFlags.Any | TypeFlags.Unknown)) !== 0) {
          return false;
        }
        if (!predicate(constituent)) return false;
      }
    }
    return true;
  }

  #constituents(type: ts.Type): readonly ts.Type[] {
    const resolved = this.#apparent(type);
    return resolved.isUnion() ? resolved.types : [resolved];
  }

  /**
   * A bare type parameter is whatever its constraint says and nothing more —
   * reading it as its default `unknown` is the safe direction and falls out of
   * `#all`'s any/unknown rejection.
   */
  #apparent(type: ts.Type): ts.Type {
    if (type.isTypeParameter()) {
      return this.#checker.getBaseConstraintOfType(type) ?? type;
    }
    return type;
  }
}

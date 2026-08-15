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

  /**
   * Existential where `isCallable` is universal. Discharging a hazard asks
   * "is this *certainly* a function?"; deciding whether a parameter needs a
   * condition asks "could control reach into it at all?", and
   * `EventListenerOrEventListenerObject | null` must answer yes to the second
   * while answering no to the first.
   *
   * It stays narrow on purpose. "Any object with a method" would be the widest
   * safe answer and also a useless one — `Element` has methods, so every DOM
   * member taking an element would need a condition and floor without one.
   */
  mayBeCallable(types: readonly ts.Type[]): boolean {
    for (const declared of types) {
      for (const constituent of this.#constituents(declared)) {
        if (constituent.getCallSignatures().length > 0) return true;
        if (constituent.getSymbol()?.getName() === "Function") return true;
        // A single-method object type is how a WebIDL *callback interface*
        // reaches TypeScript (`interface EventListenerObject { handleEvent(…) }`),
        // and entering it is the same transfer of control. The object test is
        // load-bearing: `boolean`'s apparent type is `interface Boolean {
        // valueOf(): boolean }`, a single-method type that transfers control
        // nowhere, and without it every optional flag reads as a callback.
        if ((constituent.flags & this.#ts.TypeFlags.Object) === 0) continue;
        const properties = constituent.getProperties();
        if (
          properties.length === 1 &&
          properties[0] !== undefined &&
          this.#checker.getTypeOfSymbol(properties[0]).getCallSignatures().length > 0
        ) {
          return true;
        }
      }
    }
    return false;
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

  /**
   * Some overload declares `null` at this position. The nullish halves read
   * apart, and existential like `mayBeCallable`: `isNonNullish` is universal
   * and answers for `undefined` too, so this is not its negation.
   *
   * It asks what a call may *pass*, which makes it a question for whoever is
   * choosing values to drive a position with — the fuzz gate, deciding whether
   * `null` is a conformant argument there. No entry may rest on it. One that
   * did would be true only relative to the declaration it was generated
   * against, and false in a program that merges into that declaration or does
   * not typecheck; where a claim needs to exclude `null`, the condition form
   * says so and the discharge reads the syntax.
   */
  mayBeNull(types: readonly ts.Type[]): boolean {
    const { TypeFlags } = this.#ts;
    for (const declared of types) {
      for (const constituent of this.#constituents(declared)) {
        if ((constituent.flags & TypeFlags.Null) !== 0) return true;
      }
    }
    return false;
  }

  isNonNullish(types: readonly ts.Type[]): boolean {
    const { TypeFlags } = this.#ts;
    const nullish = TypeFlags.Undefined | TypeFlags.Null | TypeFlags.Void;
    return this.#all(types, (type) => (type.flags & nullish) === 0);
  }

  /**
   * Every constituent is a string *literal* — a closed set of names, which is
   * what discharges an enumerated-value check. A bare `string` is not one: it
   * promises nothing about its contents.
   */
  isStringLiteralUnion(types: readonly ts.Type[]): boolean {
    return this.#all(types, (type) => type.isStringLiteral());
  }

  /**
   * Every constituent is the named interface or inherits from it. This is the
   * brand test: WebIDL's wrong-type guards name an interface, and TypeScript's
   * declaration of the same position is what says whether a call can reach one.
   */
  isSubtypeOf(types: readonly ts.Type[], name: string): boolean {
    return this.#all(types, (type) => this.#inheritsFrom(type, name, 0));
  }

  #inheritsFrom(type: ts.Type, name: string, depth: number): boolean {
    if (depth > 8) return false;
    if (type.getSymbol()?.getName() === name) return true;
    for (const base of type.isClassOrInterface() ? this.#checker.getBaseTypes(type) : []) {
      if (this.#inheritsFrom(base, name, depth + 1)) return true;
    }
    return false;
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
        // An unconstrained type parameter carries none of the flags a
        // predicate tests, so one phrased as an *absence* — `isNonNullish` —
        // would read it as holding. The caller picks the instantiation:
        // `Object.getOwnPropertyDescriptors<T>(o: T)` is `T = undefined` for
        // anyone who passes `undefined`, and that throws.
        if (constituent.isTypeParameter()) return false;
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
   * A bare type parameter is whatever its constraint says and nothing more. One
   * with no constraint has nothing to resolve to and is left as itself, which
   * is why `#all` has to reject it by name.
   */
  #apparent(type: ts.Type): ts.Type {
    if (type.isTypeParameter()) {
      return this.#checker.getBaseConstraintOfType(type) ?? type;
    }
    return type;
  }
}

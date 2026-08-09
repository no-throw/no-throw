import type { LibProgram } from "@no-throw/core/baseline";
import type ts from "typescript";

import { constructTypedArray, isTypedArrayName } from "../typed-arrays.js";

/** Every kind of value there is, for a position that promises nothing. */
const UNCONSTRAINED: readonly unknown[] = [
  undefined,
  null,
  0,
  "",
  {},
  [],
  Symbol("s"),
  1n,
  (): number => 1,
];

/**
 * Values for a declared type, driven off the `ts.Type` rather than off the
 * text of a type node. Refusing is a first-class answer: **refuse to fuzz what
 * you cannot model conformantly**, because a non-conformant argument
 * manufactures a false counterexample, and a false counterexample turns the
 * gate from evidence into noise.
 *
 * Every pool is deliberately *benign* — hostility lives in the receiver pool.
 * That is also what makes a conditional entry probeable: the condition says
 * "clean given this argument is clean", so the probe must supply a clean one.
 */
export class Arbitrary {
  readonly #ts: typeof ts;
  readonly #checker: ts.TypeChecker;
  readonly #building = new Set<ts.Type>();

  constructor({ ts: tsApi, checker }: LibProgram) {
    this.#ts = tsApi;
    this.#checker = checker;
  }

  /** `undefined` means "cannot be modeled conformantly" — the caller skips. */
  valuesFor(declared: ts.Type): readonly unknown[] | undefined {
    const { TypeFlags } = this.#ts;
    const type = declared;

    if (declared.isUnion()) {
      const parts = declared.types.map((part) => this.valuesFor(part));
      if (parts.some((part) => part === undefined)) return undefined;
      return parts.flatMap((part) => part ?? []).slice(0, 8);
    }

    // A type parameter's constraint says what is conformant. Without one the
    // *caller* chooses the instantiation, so every value conforms under some
    // choice: `Map#get(key: K)` takes a symbol at `Map<symbol, V>`, and the
    // receiver pool's `new Map()` is no instantiation in particular.
    if (declared.isTypeParameter()) {
      const constraint = this.#checker.getBaseConstraintOfType(declared);
      return constraint === undefined
        ? UNCONSTRAINED
        : this.valuesFor(constraint);
    }

    if (type.isStringLiteral()) return [type.value];
    if (type.isNumberLiteral()) return [type.value];
    if ((type.flags & TypeFlags.BooleanLiteral) !== 0) {
      return [(type as unknown as { intrinsicName: string }).intrinsicName === "true"];
    }
    if ((type.flags & TypeFlags.String) !== 0) {
      // Hostile but conformant, and hostile *first* so a bounded probe keeps
      // the values that can refute: malformed JSON, a truncated percent-escape,
      // a lone backslash. A `string` promises nothing about its contents.
      return ["", "not json", "%", "%E0%A4%A", "\\", "[", "a", "0", "{}"];
    }
    if ((type.flags & TypeFlags.Number) !== 0) {
      return [0, 1, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53];
    }
    if ((type.flags & TypeFlags.BooleanLike) !== 0) return [true, false];
    if ((type.flags & TypeFlags.BigIntLike) !== 0) return [1n, 0n];
    if ((type.flags & TypeFlags.ESSymbolLike) !== 0) return [Symbol("s")];
    if ((type.flags & (TypeFlags.Undefined | TypeFlags.Void)) !== 0) {
      return [undefined];
    }
    if ((type.flags & TypeFlags.Null) !== 0) return [null];
    if ((type.flags & (TypeFlags.Any | TypeFlags.Unknown)) !== 0) {
      return UNCONSTRAINED;
    }
    if ((type.flags & TypeFlags.NonPrimitive) !== 0) {
      return [{}, Object.freeze({}), [], Object.create(null)];
    }

    return this.#objectValues(type);
  }

  #objectValues(type: ts.Type): readonly unknown[] | undefined {
    if (type.getCallSignatures().length > 0) {
      return [(): number => 1, (value: unknown): unknown => value];
    }
    if (type.getConstructSignatures().length > 0) return [class Sample {}];

    const name = type.getSymbol()?.getName();

    if (name === "__type" && type.getProperties().length === 0) {
      const indexes = this.#checker.getIndexInfosOfType(type);
      // `{}` — an anonymous object type with nothing in it accepts any
      // non-nullish value, which is exactly what `Object.keys`'s second
      // overload declares.
      if (indexes.length === 0) {
        return [{}, [], 1, "a", Object.freeze({}), Object.create(null)];
      }
      // `{ [s: string]: T }` — an index signature says what a key holds when
      // it is present and never that any key is present, so an object with no
      // keys conforms to every one of them. Populating one key as well is what
      // makes this a probe of the iteration rather than of the empty case:
      // `Object.entries` and `Object.values` are declared this way.
      const held = this.#indexValue(indexes);
      return [
        {},
        Object.freeze({}),
        Object.create(null),
        ...(held === undefined ? [] : [{ key: held }]),
      ];
    }

    // An empty collection conforms to *any* element type, so it probes members
    // whose element type could not be modeled on its own.
    const element = this.#elementValues(type);
    switch (name) {
      case "Array":
      case "ReadonlyArray":
      case "ConcatArray":
      case "Iterable":
      case "IterableIterator":
      case "Iterator":
        return element === undefined ? [[]] : [[], element];
      case "ArrayLike":
        return element === undefined ? [{ length: 0 }] : [{ length: 0 }, element];
      case "Set":
      case "ReadonlySet":
      case "ReadonlySetLike":
        return [new Set(), ...(element === undefined ? [] : [new Set(element)])];
      case "Map":
      case "ReadonlyMap":
        return [new Map()];
      case "WeakMap":
        return [new WeakMap()];
      case "WeakSet":
        return [new WeakSet()];
      case "Promise":
      case "PromiseLike":
        return [Promise.resolve(undefined)];
      case "RegExp":
        return [/a/, /b/g];
      case "Date":
        return [new Date(0)];
      case "ArrayBuffer":
      case "ArrayBufferLike":
        return [new ArrayBuffer(8)];
      case "SharedArrayBuffer":
        return typeof SharedArrayBuffer === "function"
          ? [new SharedArrayBuffer(8)]
          : undefined;
      case "ArrayBufferView":
      case "DataView":
        return [new DataView(new ArrayBuffer(8))];
      case "PropertyDescriptor":
        return [{ value: 1 }, { get: (): number => 1 }];
      case "WeakKey":
      case "Object":
        return [{}];
      case "Function":
        return [(): number => 1];
      default: {
        if (name !== undefined && isTypedArrayName(name)) {
          const fresh = constructTypedArray(name, 4);
          return fresh === undefined ? undefined : [fresh];
        }
        return this.#fromProperties(type);
      }
    }
  }

  /**
   * The last resort: build the object out of its own declaration. Every
   * required property has to be modelable, since an object missing one does
   * not conform; the optional ones are left off, which is what makes `{}` the
   * value for a bag of options like `ErrorOptions`.
   *
   * A *required* property that is callable refuses the whole type. `() => 1`
   * conforms to a signature's arity and to nothing else, and a member that
   * drives what it is handed — `ReadonlySetLike.keys` has to return an iterator
   * — would refute on the model rather than on the entry. An optional one is
   * simply left off, which is why `ProxyHandler` builds and `ReadonlySetLike`
   * does not.
   */
  #fromProperties(type: ts.Type): readonly unknown[] | undefined {
    // A type that contains itself has no finite value to build.
    if (this.#building.has(type)) return undefined;
    this.#building.add(type);
    try {
      const built: Record<string, unknown> = {};
      for (const property of type.getProperties()) {
        if ((property.flags & this.#ts.SymbolFlags.Optional) !== 0) continue;
        const declared = this.#checker.getTypeOfSymbol(property);
        if (this.#modelsAsFunction(declared)) return undefined;
        const values = this.valuesFor(declared);
        if (values === undefined || values.length === 0) return undefined;
        built[property.getName()] = values[0];
      }
      return [built];
    } finally {
      this.#building.delete(type);
    }
  }

  /** Whether the pool for this type would be a bare function. */
  #modelsAsFunction(type: ts.Type): boolean {
    const parts = type.isUnion() ? type.types : [type];
    return parts.some((part) => part.getCallSignatures().length > 0);
  }

  /** One value an index signature admits, where any of them is modelable. */
  #indexValue(indexes: readonly ts.IndexInfo[]): unknown {
    for (const index of indexes) {
      const values = this.valuesFor(index.type);
      if (values !== undefined && values.length > 0) return values[0];
    }
    return undefined;
  }

  /** A short array of the element type, when the element type is modelable. */
  #elementValues(type: ts.Type): unknown[] | undefined {
    const argument = this.#checker.getTypeArguments(type as ts.TypeReference)[0];
    const element =
      argument ??
      this.#checker.getIndexTypeOfType(type, this.#ts.IndexKind.Number);
    if (element === undefined) return undefined;
    if (element.isTypeParameter()) return undefined;
    const values = this.valuesFor(element);
    return values === undefined || values.length === 0 ? undefined : [values[0]];
  }
}

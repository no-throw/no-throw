import type { LibProgram } from "@nothrow/core/baseline";
import type ts from "typescript";

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

  constructor({ ts: tsApi, checker }: LibProgram) {
    this.#ts = tsApi;
    this.#checker = checker;
  }

  /** `undefined` means "cannot be modelled conformantly" — the caller skips. */
  valuesFor(declared: ts.Type): readonly unknown[] | undefined {
    const { TypeFlags } = this.#ts;
    const type = declared;

    if (declared.isUnion()) {
      const parts = declared.types.map((part) => this.valuesFor(part));
      if (parts.some((part) => part === undefined)) return undefined;
      return parts.flatMap((part) => part ?? []).slice(0, 8);
    }

    // A bare type parameter's constraint is the only thing that says what is
    // conformant; without one there is nothing to conform to.
    if (declared.isTypeParameter()) {
      const constraint = this.#checker.getBaseConstraintOfType(declared);
      return constraint === undefined ? undefined : this.valuesFor(constraint);
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
      return [undefined, null, 0, "", {}, [], Symbol("s"), 1n, () => 1];
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
    if (name === undefined) return undefined;

    // `{}` — an anonymous object type with nothing in it accepts any
    // non-nullish value, which is exactly what `Object.keys`'s second overload
    // declares.
    if (
      name === "__type" &&
      type.getProperties().length === 0 &&
      this.#checker.getIndexInfosOfType(type).length === 0
    ) {
      return [{}, [], 1, "a", Object.freeze({}), Object.create(null)];
    }

    // An empty collection conforms to *any* element type, so it probes members
    // whose element type could not be modelled on its own.
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
      case "Int8Array":
      case "Uint8Array":
      case "Uint8ClampedArray":
      case "Int16Array":
      case "Uint16Array":
      case "Int32Array":
      case "Uint32Array":
      case "Float16Array":
      case "Float32Array":
      case "Float64Array":
      case "BigInt64Array":
      case "BigUint64Array": {
        const Constructor = (globalThis as Record<string, unknown>)[name];
        return typeof Constructor === "function"
          ? [Reflect.construct(Constructor, [4])]
          : undefined;
      }
      default:
        return undefined;
    }
  }

  /** A short array of the element type, when the element type is modellable. */
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

import type { LibProgram } from "@nothrow/core/baseline";
import type ts from "typescript";

import type { DomEnvironment } from "./environment.js";

/**
 * Values for a declared type, driven off the `ts.Type` rather than off the text
 * of a type node. Two rules from #25 govern it, and both are about keeping the
 * gate evidence rather than noise:
 *
 * - **Refuse to fuzz what you cannot model conformantly.** A non-conformant
 *   argument manufactures a false counterexample, which is worse than no probe.
 * - **Hostile, never non-conformant.** `''`, `'!'`, `-1`, `2147483648`, `NaN`,
 *   an ancestor node, a detached node, a node from another document — every one
 *   of them satisfies the declared type. #26 measured the difference: benign
 *   arguments refuted 0 of 7 controls, these refuted 7 of 7.
 *
 * Callbacks are the exception, and deliberately: a clean claim on a
 * callback-taking member is *conditional*, so the probe must supply a clean
 * callback or it would refute the condition rather than the member.
 */

/**
 * Hostile *first*. The budget is spent round-robin across a member's overloads,
 * and `ParentNode.querySelector` declares five — so a pool that leads with a
 * benign value pushes the empty string that refutes it past the cut. #25 made
 * the same ordering choice for the same reason.
 */
const HOSTILE_STRINGS = [
  "",
  "!",
  "<x>",
  "a",
  " ",
  ":",
  "#",
  "1e",
  "a".repeat(2048),
];

const HOSTILE_NUMBERS = [-1, 2147483648, Number.NaN, 1e308, 0.5, -1e9, 0, 1];

const MAX_VALUES = 8;

export class Arbitrary {
  readonly #ts: typeof ts;
  readonly #checker: ts.TypeChecker;
  readonly #environment: DomEnvironment;
  readonly #hostileNodes: readonly unknown[];

  constructor(lib: LibProgram, environment: DomEnvironment) {
    this.#ts = lib.ts;
    this.#checker = lib.checker;
    this.#environment = environment;
    const { document } = environment;
    const foreign = document.implementation.createHTMLDocument("other");
    this.#hostileNodes = [
      // An ancestor of the probe's receivers: appending it makes a cycle.
      document.documentElement,
      // Detached, and from a different document. Both are ordinary `Node`s.
      document.createElement("div"),
      foreign.createElement("div"),
    ];
  }

  /** `undefined` means "cannot be modeled conformantly" — the caller skips. */
  valuesFor(declared: ts.Type, depth = 0): readonly unknown[] | undefined {
    if (depth > 4) return undefined;
    const { TypeFlags } = this.#ts;

    if (declared.isUnion()) {
      const parts = declared.types.map((part) => this.valuesFor(part, depth + 1));
      const usable = parts.filter(
        (part): part is readonly unknown[] => part !== undefined,
      );
      // A union arm this engine cannot model does not refuse the whole
      // parameter: the other arms are still conformant values for it.
      return usable.length === 0 ? undefined : usable.flat().slice(0, MAX_VALUES);
    }

    // A bare type parameter's constraint is the only thing that says what is
    // conformant; without one there is nothing to conform to. With one —
    // `appendChild<T extends Node>` — the constraint *is* the declared type.
    if (declared.isTypeParameter()) {
      const constraint = this.#checker.getBaseConstraintOfType(declared);
      return constraint === undefined ? undefined : this.valuesFor(constraint, depth + 1);
    }

    // `isUnion`/`isTypeParameter` are narrowing guards, so the checks above
    // leave `declared` as `never`; the alias carries the type past them.
    const type: ts.Type = declared;
    if (type.isStringLiteral()) return [type.value];
    if (type.isNumberLiteral()) return [type.value];
    if ((type.flags & TypeFlags.BooleanLiteral) !== 0) {
      return [(type as unknown as { intrinsicName: string }).intrinsicName === "true"];
    }
    if ((type.flags & TypeFlags.String) !== 0) return HOSTILE_STRINGS;
    if ((type.flags & TypeFlags.Number) !== 0) return HOSTILE_NUMBERS;
    if ((type.flags & TypeFlags.BigIntLike) !== 0) return [1n, 0n];
    if ((type.flags & TypeFlags.BooleanLike) !== 0) return [true, false];
    if ((type.flags & TypeFlags.ESSymbolLike) !== 0) return [Symbol("s")];
    if ((type.flags & (TypeFlags.Undefined | TypeFlags.Void)) !== 0) {
      return [undefined];
    }
    if ((type.flags & TypeFlags.Null) !== 0) return [null];
    if ((type.flags & (TypeFlags.Any | TypeFlags.Unknown)) !== 0) {
      // `any` really does admit all of these, so a throw one of them provokes
      // is a throw a conformant caller can provoke.
      return [undefined, null, 0, "", {}, [], () => 1];
    }
    if ((type.flags & TypeFlags.NonPrimitive) !== 0) {
      return [{}, Object.freeze({}), [], Object.create(null)];
    }

    return this.#objectValues(type, depth);
  }

  #objectValues(type: ts.Type, depth: number): readonly unknown[] | undefined {
    if (type.getCallSignatures().length > 0) return [(): void => undefined];
    if (type.getConstructSignatures().length > 0) return [class Sample {}];

    const name = type.getSymbol()?.getName();
    if (name === undefined) return undefined;

    const element = this.#elementValues(type, depth);
    switch (name) {
      case "Array":
      case "ReadonlyArray":
      case "Iterable":
      case "IterableIterator":
        return element === undefined ? [[]] : [[], element];
      case "ArrayBuffer":
      case "ArrayBufferLike":
        return [new ArrayBuffer(8)];
      case "ArrayBufferView":
      case "DataView":
        return [new DataView(new ArrayBuffer(8))];
      case "Uint8Array":
        return [new Uint8Array(4)];
      case "Promise":
      case "PromiseLike":
        return [Promise.resolve(undefined)];
      case "Date":
        return [new Date(0)];
      case "RegExp":
        return [/a/];
      case "Object":
        return [{}];
      case "Function":
        return [(): void => undefined];
      default:
        break;
    }

    const instance = this.#environment.pool.get(name);
    if (instance !== undefined) {
      // A `Node` argument is where the DOM's hostility lives: an ancestor of
      // the receiver makes a cycle, a detached node has no parent, and a node
      // from another document is foreign — all three are still `Node`s.
      return this.#isNode(instance) ? [instance, ...this.#hostileNodes] : [instance];
    }

    return this.#dictionaryValue(type, depth);
  }

  /**
   * A dictionary is an options bag: TypeScript declares the required members as
   * required properties, so the empty object is conformant only when there are
   * none. A required member this engine cannot model refuses the whole
   * parameter rather than being left out.
   */
  #dictionaryValue(type: ts.Type, depth: number): readonly unknown[] | undefined {
    const properties = type.getProperties();
    if (properties.length === 0) return undefined;
    const bag: Record<string, unknown> = {};
    for (const property of properties) {
      if ((property.flags & this.#ts.SymbolFlags.Optional) !== 0) continue;
      const values = this.valuesFor(this.#checker.getTypeOfSymbol(property), depth + 1);
      if (values === undefined || values.length === 0) return undefined;
      bag[property.getName()] = values[0];
    }
    return [bag];
  }

  #elementValues(type: ts.Type, depth: number): unknown[] | undefined {
    const argument = this.#checker.getTypeArguments(type as ts.TypeReference)[0];
    if (argument === undefined || argument.isTypeParameter()) return undefined;
    const values = this.valuesFor(argument, depth + 1);
    return values === undefined || values.length === 0 ? undefined : [values[0]];
  }

  #isNode(value: unknown): boolean {
    const NodeConstructor = (this.#environment.window as unknown as Record<string, unknown>)[
      "Node"
    ];
    return (
      typeof NodeConstructor === "function" && value instanceof (NodeConstructor as never)
    );
  }
}

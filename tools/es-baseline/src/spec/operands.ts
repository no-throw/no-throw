import type { PathSegment } from "@no-throw/core/baseline";

import { argumentsOf, splitArguments } from "./parse.js";

/**
 * A hazard is *about* some value. Tracing which one — and through which
 * property accesses — is the whole game: a root cause is about the callee's
 * parameter *i*, so lifting it into a caller means re-resolving the expression
 * the caller passed at *i*, recursively, until the chain ends at a builtin's
 * declared parameter or its receiver. Without that the hazard set is sound and
 * useless.
 *
 * The segments make the result a *path* rather than a position, which is what
 * lets `Array.prototype.push` discharge (its coercion is about `O.length`, not
 * about `O`) and what conditional entries are written in — so they are the wire
 * format's own segment type, not a parallel one.
 */
export interface Operand {
  readonly root: "param" | "receiver" | "internal";
  /** Meaningful only when `root` is `"param"`. */
  readonly index: number;
  readonly segments: readonly PathSegment[];
  /** The spec expression this was read off, for the audit trail. */
  readonly text: string;
}

const INTERNAL: Operand = { root: "internal", index: -1, segments: [], text: "" };

const withSegment = (base: Operand, segment: PathSegment): Operand => ({
  root: base.root,
  index: base.index,
  segments: [...base.segments, segment],
  text: base.text,
});

/** `"length"` → `.length`; `%Symbol.iterator%` → `.@@iterator`. */
function keySegment(key: string | undefined): PathSegment | undefined {
  if (key === undefined) return undefined;
  const symbol = /%Symbol\.(\w+)%/.exec(key);
  if (symbol?.[1] !== undefined) return { kind: "symbol", name: symbol[1] };
  const literal = /^"([^"]+)"$/.exec(key.trim());
  if (literal?.[1] !== undefined) return { kind: "member", name: literal[1] };
  return undefined;
}

/**
 * How an abstract operation moves the path. Each entry says: when this
 * operation appears in an expression, the value the expression denotes is the
 * first argument's, one step further along the path.
 */
interface PathStep {
  readonly ops: readonly string[];
  /** `undefined` means "the elements of", which replaces rather than appends. */
  readonly segment: PathSegment | undefined;
  /** Property reads name the key in a second argument. */
  readonly keyFromArgument?: true;
}

const PATH_STEPS: readonly PathStep[] = [
  // Property reads: the hazard is about the property, not about the object.
  {
    ops: ["Get", "GetV", "GetMethod", "Invoke"],
    segment: undefined,
    keyFromArgument: true,
  },
  // Definitionally `Get(obj, "length")` followed by a coercion.
  {
    ops: ["LengthOfArrayLike"],
    segment: { kind: "member", name: "length" },
  },
  {
    ops: ["GetIterator", "GetIteratorFromMethod"],
    segment: { kind: "symbol", name: "iterator" },
  },
  // Yield the *elements* of whatever was iterated.
  {
    ops: [
      "IteratorStepValue",
      "IteratorValue",
      "IteratorToList",
      "CreateListFromArrayLike",
      "IterableToList",
    ],
    segment: undefined,
  },
];

export class OperandTrace {
  readonly #origins = new Map<string, Operand>();

  constructor(params: readonly string[], steps: readonly string[]) {
    params.forEach((param, index) => {
      const name = param.replace(/^\.{3}/, "").trim();
      if (name !== "") {
        this.#origins.set(name, { root: "param", index, segments: [], text: name });
      }
    });

    for (const step of steps) {
      const assignment = /^(?:Let|Set) (\w+) (?:be|to) (.*)$/.exec(step);
      if (assignment?.[1] !== undefined && assignment[2] !== undefined) {
        this.#origins.set(assignment[1], this.resolve(assignment[2]));
        continue;
      }
      const loop = /^For each (?:\w+ )*?(\w+) (?:of|in) (\w+)/.exec(step);
      if (loop?.[1] !== undefined && loop[2] !== undefined) {
        this.#origins.set(
          loop[1],
          withSegment(this.resolve(loop[2]), { kind: "element" }),
        );
      }
    }
  }

  /** The operand a spec expression denotes. */
  resolve(expression: string): Operand {
    const text = expression.trim();
    if (text === "") return INTERNAL;
    if (/\bthis value\b/.test(text)) {
      return { root: "receiver", index: -1, segments: [], text };
    }

    for (const step of PATH_STEPS) {
      for (const op of step.ops) {
        const args = splitArguments(argumentsOf(text, op));
        if (args.length === 0) continue;
        const segment = step.keyFromArgument
          ? keySegment(args[1])
          : step.segment;
        if (step.keyFromArgument && segment === undefined) continue;
        const base = this.resolve(args[0] ?? "");
        if (base.root === "internal") continue;
        return segment === undefined
          ? elementsOf(base)
          : withSegment(base, segment);
      }
    }

    const named = this.#firstKnownName(text);
    return named === undefined ? INTERNAL : { ...named, text };
  }

  /** The variable a throw condition is about: the first name it mentions. */
  subjectOf(condition: string): Operand {
    return this.#firstKnownName(condition) ?? INTERNAL;
  }

  /**
   * The value an expression denotes is the one it names *first*.
   * `obj.[[Delete]](propertyKey)` is about `obj`; reading it as being about
   * `propertyKey` re-roots the whole hazard on the wrong parameter, and every
   * caller then discharges it against the wrong declared type. Ties break to
   * the longer name so a prefix never shadows the name containing it.
   */
  #firstKnownName(text: string): Operand | undefined {
    let best: string | undefined;
    let bestAt = Number.POSITIVE_INFINITY;
    for (const name of this.#origins.keys()) {
      const at = text.search(new RegExp(`\\b${name}\\b`));
      if (at < 0) continue;
      if (at < bestAt || (at === bestAt && name.length > (best?.length ?? 0))) {
        best = name;
        bestAt = at;
      }
    }
    if (best === undefined) return undefined;
    const origin = this.#origins.get(best);
    return origin === undefined ? undefined : { ...origin, text: best };
  }
}

/**
 * Elements of a value that was iterated. Stepping an iterator obtained from
 * `x` yields `x`'s elements, so the `.@@iterator` hop the path picked up on
 * the way in is replaced rather than appended to.
 */
function elementsOf(base: Operand): Operand {
  const last = base.segments[base.segments.length - 1];
  const wasIteratorHop =
    last !== undefined &&
    last.kind === "symbol" &&
    (last.name === "iterator" || last.name === "asyncIterator");
  const trimmed = wasIteratorHop ? base.segments.slice(0, -1) : base.segments;
  return {
    root: base.root,
    index: base.index,
    segments: [...trimmed, { kind: "element" }],
    text: base.text,
  };
}

/**
 * Re-root a callee's operand in the caller. A cause about the callee's
 * parameter *i* becomes a cause about whatever the caller passed at *i*, with
 * the callee-side property path kept intact.
 */
export function liftOperand(
  callee: Operand,
  callerArguments: readonly string[],
  caller: OperandTrace,
): Operand {
  const passed =
    callee.root === "param" ? callerArguments[callee.index] : callerArguments[0];
  if (passed === undefined) return { ...INTERNAL, text: callee.text };
  const base = caller.resolve(passed);
  if (base.root === "internal") return { ...INTERNAL, text: passed };
  return {
    root: base.root,
    index: base.index,
    segments: [...base.segments, ...callee.segments],
    text: passed,
  };
}

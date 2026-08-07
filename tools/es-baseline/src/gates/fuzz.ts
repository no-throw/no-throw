import type { LibMember, LibProgram } from "@nothrow/core/baseline";
import type ts from "typescript";

import { resolveHolder, runtimeKey } from "../accessors.js";
import { Arbitrary } from "./arbitrary.js";
import { describe, receiverPool } from "./receivers.js";

export interface Counterexample {
  readonly key: string;
  readonly probe: "call" | "get";
  readonly error: string;
  readonly message: string;
  readonly receiver: string;
  readonly args: readonly string[];
}

export interface ProbeResult {
  readonly key: string;
  readonly probe: "call" | "get";
  /** False means *unprobed* — which is not a refutation and not evidence. */
  readonly probed: boolean;
  readonly skipped: string | undefined;
  readonly calls: number;
  /** The call budget ran out: this member is probed, but not exhaustively. */
  readonly truncated: boolean;
  readonly counterexamples: readonly Counterexample[];
}

/**
 * A bound on work, and the one place coverage is deliberately cut — so it is
 * reported rather than silently applied.
 */
const MAX_CALLS = 400;
const MAX_VALUES_PER_PARAMETER = 6;

export class HostileFuzzer {
  readonly #arbitrary: Arbitrary;
  readonly #receivers = receiverPool();

  constructor(lib: LibProgram) {
    this.#arbitrary = new Arbitrary(lib);
  }

  /** Drive a member with hostile receivers and conformant arguments. */
  probeCall(member: LibMember): ProbeResult {
    const target = this.#target(member);
    if (typeof target !== "function") {
      return skip(member.key, "call", "not implemented by this engine");
    }

    const receivers = this.#receiversFor(member);
    if (receivers.length === 0) {
      return skip(member.key, "call", "no constructible receiver");
    }

    const pools: (readonly unknown[])[] = [];
    let restFrom: number | undefined;
    for (const [index, parameter] of (member.params ?? []).entries()) {
      const values = this.#valuesForParameter(parameter);
      if (values === undefined || values.length === 0) {
        return skip(
          member.key,
          "call",
          `parameter ${parameter.name} cannot be modelled conformantly`,
        );
      }
      if (parameter.rest) restFrom = index;
      pools.push(values);
    }

    const tuples = argumentTuples(pools, member);
    const counterexamples: Counterexample[] = [];
    let calls = 0;
    let truncated = false;

    outer: for (const receiver of receivers) {
      for (const args of tuples) {
        if (++calls > MAX_CALLS) {
          truncated = true;
          break outer;
        }
        try {
          const result = Reflect.apply(target, receiver, spread(args, restFrom));
          // A rejected promise is the member's own colour, not a sync throw.
          if (isThenable(result)) result.then(noop, noop);
        } catch (error) {
          counterexamples.push(
            counterexample(member.key, "call", error, receiver, args),
          );
        }
      }
    }

    return {
      key: member.key,
      probe: "call",
      probed: true,
      skipped: undefined,
      calls,
      truncated,
      counterexamples,
    };
  }

  /** Read a member as a property: the accessor fact's `get` colour. */
  probeGet(member: LibMember): ProbeResult {
    const key = runtimeKey(member.name);
    const receivers = this.#receiversFor(member);
    if (key === undefined || receivers.length === 0) {
      return skip(member.key, "get", "no constructible receiver");
    }
    const counterexamples: Counterexample[] = [];
    let calls = 0;
    for (const receiver of receivers) {
      calls++;
      try {
        void (receiver as Record<string | symbol, unknown>)[key];
      } catch (error) {
        counterexamples.push(
          counterexample(member.key, "get", error, receiver, []),
        );
      }
    }
    return {
      key: member.key,
      probe: "get",
      probed: true,
      skipped: undefined,
      calls,
      truncated: false,
      counterexamples,
    };
  }

  #target(member: LibMember): unknown {
    const holder = resolveHolder(member.holderPath);
    const key = runtimeKey(member.name);
    if (holder === undefined || key === undefined) return undefined;
    try {
      return (holder as Record<string | symbol, unknown>)[key];
    } catch {
      return undefined;
    }
  }

  #receiversFor(member: LibMember): readonly unknown[] {
    if (member.isStatic || member.holderPath === "") {
      const holder = resolveHolder(member.holderPath);
      return holder === undefined ? [] : [holder];
    }
    return this.#receivers.get(member.receiverOwner) ?? [];
  }

  #valuesForParameter(
    parameter: LibMember["params"] extends readonly (infer P)[] | undefined
      ? P
      : never,
  ): readonly unknown[] | undefined {
    // Every overload's type must be modelled: the entry covers all of them.
    const pools = parameter.types.map((type: ts.Type) =>
      this.#arbitrary.valuesFor(type),
    );
    if (pools.some((pool) => pool === undefined)) return undefined;
    const values = pools
      .flatMap((pool) => pool ?? [])
      .slice(0, MAX_VALUES_PER_PARAMETER);
    return parameter.optional ? [...values, undefined] : values;
  }
}

function argumentTuples(
  pools: readonly (readonly unknown[])[],
  member: LibMember,
): readonly (readonly unknown[])[] {
  const first = pools.map((pool) => pool[0]);
  const tuples: (readonly unknown[])[] = [first];
  pools.forEach((pool, index) => {
    for (const value of pool.slice(1)) {
      const tuple = [...first];
      tuple[index] = value;
      tuples.push(tuple);
    }
  });
  // Omitting arguments is only conformant when every parameter is optional.
  if ((member.params ?? []).every((parameter) => parameter.optional)) {
    tuples.push([]);
  }
  return tuples;
}

/** A rest parameter's pool holds arrays; its values are passed as trailing arguments. */
function spread(
  args: readonly unknown[],
  restFrom: number | undefined,
): unknown[] {
  if (restFrom === undefined) return [...args];
  const head = args.slice(0, restFrom);
  const tail = args[restFrom];
  return [...head, ...(Array.isArray(tail) ? tail : tail === undefined ? [] : [tail])];
}

function counterexample(
  key: string,
  probe: "call" | "get",
  error: unknown,
  receiver: unknown,
  args: readonly unknown[],
): Counterexample {
  const thrown = error as { constructor?: { name?: string }; message?: string };
  return {
    key,
    probe,
    error: thrown?.constructor?.name ?? "unknown",
    message: String(thrown?.message ?? error).slice(0, 120),
    receiver: describe(receiver),
    args: args.map(describe),
  };
}

function skip(key: string, probe: "call" | "get", reason: string): ProbeResult {
  return {
    key,
    probe,
    probed: false,
    skipped: reason,
    calls: 0,
    truncated: false,
    counterexamples: [],
  };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

function noop(): void {
  /* a float here is the fuzzer's, not the program's */
}

import type { LibMember, LibParam, LibProgram } from "@no-throw/core/baseline";
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
          `parameter ${parameter.name} cannot be modeled conformantly`,
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
          // A rejected promise is the member's own color, not a sync throw.
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

  /** Read a member as a property: the accessor fact's `get` color. */
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

  /**
   * A fresh pool per member. The probes mutate what they are given —
   * `Array.prototype.push` grows an array, `ArrayBuffer.prototype.transfer`
   * detaches a buffer — so a shared pool would make one member's result depend
   * on which members ran before it, and a manufactured counterexample is
   * exactly what turns the gate into noise.
   */
  #receiversFor(member: LibMember): readonly unknown[] {
    if (member.isStatic || member.holderPath === "") {
      const holder = resolveHolder(member.holderPath);
      return holder === undefined ? [] : [holder];
    }
    return receiverPool().get(member.receiverOwner) ?? [];
  }

  #valuesForParameter(parameter: LibParam): readonly unknown[] | undefined {
    // Every overload's type must be modeled: the entry covers all of them. So
    // the budget is spent round-robin rather than in order — taking the first
    // overload's values until the budget runs out would put the later
    // signatures' refuting values out of reach.
    const pools = parameter.types.map((type: ts.Type) =>
      this.#arbitrary.valuesFor(type),
    );
    if (pools.some((pool) => pool === undefined)) return undefined;
    const values = interleave(pools as readonly (readonly unknown[])[]).slice(
      0,
      MAX_VALUES_PER_PARAMETER,
    );
    return parameter.optional ? [...values, undefined] : values;
  }
}

function interleave(pools: readonly (readonly unknown[])[]): unknown[] {
  const out: unknown[] = [];
  const longest = Math.max(0, ...pools.map((pool) => pool.length));
  for (let index = 0; index < longest; index++) {
    for (const pool of pools) {
      if (index < pool.length) out.push(pool[index]);
    }
  }
  return out;
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

/** One line a maintainer can act on: what threw, on what, with what. */
export function formatCounterexample(found: Counterexample): string {
  return `${found.key.padEnd(38)} ${found.probe} ${found.error}: ${found.message} [receiver ${found.receiver}, args ${JSON.stringify(found.args)}]`;
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

import type { DomMember, LibParam, LibProgram } from "@nothrow/core/baseline";

import { Arbitrary } from "./arbitrary.js";
import { createDomEnvironment, receiverFor, type DomEnvironment } from "./environment.js";

export interface Counterexample {
  readonly key: string;
  readonly probe: "call" | "get";
  readonly error: string;
  readonly message: string;
  readonly receiver: string;
  readonly args: readonly string[];
  /** A rejection, not a synchronous throw. Same hazard under #12's one color. */
  readonly async: boolean;
}

export interface ProbeResult {
  readonly key: string;
  readonly probe: "call" | "get";
  /** False means *unprobed* — which is not a refutation and not evidence. */
  readonly probed: boolean;
  readonly skipped: string | undefined;
  readonly calls: number;
  readonly truncated: boolean;
  readonly counterexamples: readonly Counterexample[];
}

/**
 * Members that navigate, block on a dialog, spawn a thread, or tear down the
 * page. A probe that destroys its own harness measures nothing after the first
 * hit, so these are **unprobed** — and therefore ship floored, exactly like a
 * member with no constructible receiver.
 */
const UNPROBEABLE = new Set([
  "alert",
  "confirm",
  "prompt",
  "print",
  "close",
  "open",
  "stop",
  "showModal",
  "showModalDialog",
  "requestFullscreen",
  "exitFullscreen",
  "requestPointerLock",
  "write",
  "writeln",
  "clear",
  "reload",
  "assign",
  "replace",
  "go",
  "back",
  "forward",
  "pushState",
  "replaceState",
  "navigate",
  "submit",
  "requestPictureInPicture",
  "showPicker",
  "showOpenFilePicker",
  "showSaveFilePicker",
  "showDirectoryPicker",
  "register",
  "unregister",
  "play",
  "load",
  "share",
  "vibrate",
  "moveTo",
  "moveBy",
  "resizeTo",
  "resizeBy",
  "claim",
  "skipWaiting",
  "terminate",
  "postMessage",
]);

/**
 * The budget, and the one place coverage is deliberately cut. It has to clear
 * the round-robin: `Document.createElement` declares three overloads, so a
 * five-value budget spent one-per-overload never reaches the empty string that
 * refutes it — which the self-check caught.
 */
const MAX_CALLS = 200;
const MAX_VALUES_PER_PARAMETER = 9;

export class HostileFuzzer {
  readonly #arbitrary: Arbitrary;
  readonly #environment: DomEnvironment;
  readonly #implementers: ReadonlyMap<string, readonly string[]>;
  readonly #pending: Promise<void>[] = [];
  readonly #rejections: Counterexample[] = [];

  constructor(
    lib: LibProgram,
    implementers: ReadonlyMap<string, readonly string[]>,
    environment: DomEnvironment = createDomEnvironment(),
  ) {
    this.#environment = environment;
    this.#implementers = implementers;
    this.#arbitrary = new Arbitrary(lib, environment);
  }

  probeCall(member: DomMember): ProbeResult {
    if (UNPROBEABLE.has(member.name)) {
      return skip(member.key, "call", "would tear down or block the harness");
    }
    const receiver = receiverFor(this.#environment, member, this.#implementers);
    if (receiver === undefined) {
      return skip(member.key, "call", "no constructible receiver");
    }

    let target: unknown;
    try {
      target = (receiver as Record<string, unknown>)[member.name];
    } catch {
      return skip(member.key, "call", "reading the member threw");
    }
    if (typeof target !== "function") {
      return skip(member.key, "call", "not implemented by this engine");
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

    const counterexamples: Counterexample[] = [];
    let calls = 0;
    let truncated = false;
    for (const args of argumentTuples(pools, member)) {
      if (++calls > MAX_CALLS) {
        truncated = true;
        break;
      }
      try {
        const result = Reflect.apply(target, receiver, spread(args, restFrom));
        this.#watchRejection(member.key, result, receiver, args);
      } catch (error) {
        counterexamples.push(
          counterexample(member.key, "call", error, receiver, args, false),
        );
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

  /** Read the member as a property: the accessor fact's `get` color. */
  probeGet(member: DomMember): ProbeResult {
    const receiver = receiverFor(this.#environment, member, this.#implementers);
    if (receiver === undefined) {
      return skip(member.key, "get", "no constructible receiver");
    }
    const counterexamples: Counterexample[] = [];
    try {
      void (receiver as Record<string, unknown>)[member.name];
    } catch (error) {
      counterexamples.push(counterexample(member.key, "get", error, receiver, [], false));
    }
    return {
      key: member.key,
      probe: "get",
      probed: true,
      skipped: undefined,
      calls: 1,
      truncated: false,
      counterexamples,
    };
  }

  /**
   * Rejections observed after the synchronous run. Under #12's one color, full
   * surface, a rejection is the same hazard as a synchronous throw: a clean
   * entry promises the call does not throw **and** the promise does not reject.
   */
  async settleRejections(): Promise<readonly Counterexample[]> {
    await Promise.race([
      Promise.allSettled(this.#pending),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    return this.#rejections;
  }

  #watchRejection(
    key: string,
    result: unknown,
    receiver: unknown,
    args: readonly unknown[],
  ): void {
    if (!isThenable(result)) return;
    this.#pending.push(
      Promise.resolve(result).then(
        () => undefined,
        (error: unknown) => {
          this.#rejections.push(
            counterexample(key, "call", error, receiver, args, true),
          );
        },
      ),
    );
  }

  #valuesForParameter(parameter: LibParam): readonly unknown[] | undefined {
    // Every overload's type must be modeled: one entry covers all of them, so
    // the budget is spent round-robin rather than in order — taking the first
    // overload's values until it runs out would put the later signatures'
    // refuting values out of reach.
    const pools = parameter.types.map((type) => this.#arbitrary.valuesFor(type));
    const usable = pools.filter(
      (pool): pool is readonly unknown[] => pool !== undefined,
    );
    if (usable.length !== pools.length) return undefined;
    const values = interleave(usable).slice(0, MAX_VALUES_PER_PARAMETER);
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

/**
 * One tuple per hostile value, varied a position at a time against a baseline
 * of first choices. The full cross product is unaffordable and buys little:
 * almost every DOM guard is about one argument.
 */
function argumentTuples(
  pools: readonly (readonly unknown[])[],
  member: DomMember,
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
  if ((member.params ?? []).every((parameter) => parameter.optional)) tuples.push([]);
  return tuples;
}

function spread(args: readonly unknown[], restFrom: number | undefined): unknown[] {
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
  async: boolean,
): Counterexample {
  const thrown = error as { name?: string; constructor?: { name?: string }; message?: string };
  return {
    key,
    probe,
    error: thrown?.name ?? thrown?.constructor?.name ?? "unknown",
    message: String(thrown?.message ?? error).slice(0, 120),
    receiver: describe(receiver),
    args: args.map(describe),
    async,
  };
}

export function describe(value: unknown): string {
  try {
    if (typeof value === "symbol") return "Symbol()";
    if (typeof value === "bigint") return `${value}n`;
    if (typeof value === "function") return "fn";
    if (typeof value === "string") {
      return value.length > 24 ? `"…${value.length} chars"` : JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.length}]`;
    if (value !== null && typeof value === "object") {
      return value.constructor?.name ?? "object";
    }
    return String(value);
  } catch {
    return "?";
  }
}

/** One line a maintainer can act on: what threw, on what, with what. */
export function formatCounterexample(found: Counterexample): string {
  return `${found.key.padEnd(40)} ${found.probe}${found.async ? " (rejected)" : ""} ${found.error}: ${found.message} [receiver ${found.receiver}, args ${JSON.stringify(found.args)}]`;
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

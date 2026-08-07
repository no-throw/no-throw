import type { ConditionPath, DomMember, LibProgram } from "@nothrow/core/baseline";
import { formatConditionPath } from "@nothrow/core/baseline";

import { Arbitrary } from "./arbitrary.js";
import { receiverFor, type DomEnvironment } from "./environment.js";
import { varyOnePosition } from "./tuples.js";

/**
 * The spec's one open item, converted to engineering (#30 §F, #21, #26).
 *
 * A member that *queues* a callback rather than invoking it is the one place
 * where forgetting an entry is unsound rather than merely over-strict: the
 * floor's only remedy is `try { el.addEventListener('x', risky) } catch {}`,
 * which the engine accepts as a bridge while it neutralizes nothing. WebIDL
 * does not say whether `NodeFilter.acceptNode` is synchronous or
 * `addEventListener` queued — but a callback that records whether it ran before
 * the call returned answers *"was I invoked synchronously?"* directly, and that
 * is the whole question a condition is about (#30 §B: which parameters does
 * this body transfer control into).
 *
 * Three outcomes, and no fourth. Nothing is left as "needs a human call":
 *
 * - **`sync`** — the callback ran during the call. An ordinary conditional
 *   entry: `conditions: ["param<i>"]`, discharged against the argument in hand.
 * - **`queued`** — the callback did not run during the call **and was seen
 *   running afterwards**. Both halves are required, and the second is what makes
 *   the verdict a positive observation rather than a silence: the probe drives
 *   `DOMTokenList.forEach` on an empty token list, and a callback that simply
 *   never runs would otherwise read as deferred when the member is plainly
 *   synchronous. Reading a relaxation off an absence is the unsafe direction —
 *   the same mistake as reading Gecko's silence as clean. Earns
 *   `conditions: []`.
 * - **`unreachable`** — the probe could not call the member, or called it and
 *   never saw the callback at all. **No relaxation, and the member floors.**
 */
export type Adjudication = "sync" | "queued" | "unreachable";

export interface DeferredVerdict {
  readonly key: string;
  readonly paramIndex: number;
  readonly path: ConditionPath;
  readonly adjudication: Adjudication;
  /**
   * The callback was seen running after the call returned. `queued` requires
   * it, and recording it as a fact rather than leaving it inside the prose of
   * `evidence` is what lets the gate check the invariant: rewording a sentence
   * must not be able to switch off the check that guards it.
   */
  readonly observedAfterCall: boolean;
  readonly evidence: string;
}

/** How long to let the environment run before concluding "not seen later". */
const SETTLE_MS = 60;
const MAX_TUPLES = 4;

export class DeferredProbe {
  readonly #arbitrary: Arbitrary;
  readonly #environment: DomEnvironment;
  readonly #implementers: ReadonlyMap<string, readonly string[]>;

  constructor(
    lib: LibProgram,
    implementers: ReadonlyMap<string, readonly string[]>,
    environment: DomEnvironment,
  ) {
    this.#environment = environment;
    this.#implementers = implementers;
    this.#arbitrary = new Arbitrary(lib, environment);
  }

  async adjudicate(
    member: DomMember,
    paramIndex: number,
  ): Promise<DeferredVerdict> {
    const path = formatConditionPath({ paramIndex, segments: [] });
    const verdict = (
      adjudication: Adjudication,
      evidence: string,
      observedAfterCall = false,
    ): DeferredVerdict => ({
      key: member.key,
      paramIndex,
      path,
      adjudication,
      observedAfterCall,
      evidence,
    });

    const receiver = receiverFor(this.#environment, member, this.#implementers);
    if (receiver === undefined) return verdict("unreachable", "no constructible receiver");

    let target: unknown;
    try {
      target = (receiver as Record<string, unknown>)[member.name];
    } catch {
      return verdict("unreachable", "reading the member threw");
    }
    if (typeof target !== "function") {
      return verdict("unreachable", "not implemented by this engine");
    }

    const tuples = this.#tuplesFor(member, paramIndex);
    if (tuples === undefined) {
      return verdict("unreachable", "arguments cannot be modeled conformantly");
    }

    let called = false;
    let firedLater = false;
    let lastError = "every call threw";

    for (const tuple of tuples) {
      const record = { ranDuringCall: false, ranLater: false, done: false };
      const callback = (): void => {
        if (record.done) record.ranLater = true;
        else record.ranDuringCall = true;
      };
      const args = tuple.map((value, index) => (index === paramIndex ? callback : value));

      try {
        Reflect.apply(target, receiver, args);
      } catch (error) {
        lastError = `call threw ${String((error as Error)?.name ?? error)}`;
        continue;
      }
      record.done = true;
      called = true;

      if (record.ranDuringCall) {
        return verdict(
          "sync",
          "the callback ran before the call returned; the throw would escape at the call site",
        );
      }

      await this.#drive(receiver, args);
      if (record.ranLater) firedLater = true;
    }

    if (!called) return verdict("unreachable", lastError);
    if (!firedLater) {
      return verdict(
        "unreachable",
        "the callback never ran, so nothing was observed either way",
      );
    }
    return verdict(
      "queued",
      "the callback did not run during the call, and was observed running afterwards",
      true,
    );
  }

  /**
   * Give the environment every chance to run the callback *after* the call:
   * dispatch what the member was registered for, drain microtasks, let timers
   * fire. Seeing it run here is the whole of the `queued` verdict — without it
   * the probe has observed nothing, and observing nothing is not evidence.
   */
  async #drive(receiver: unknown, args: readonly unknown[]): Promise<void> {
    const window = this.#environment.window as unknown as {
      Event?: new (type: string, init?: unknown) => Event;
      EventTarget?: new () => EventTarget;
    };
    const EventConstructor = window.Event;
    const EventTargetConstructor = window.EventTarget;
    if (
      EventConstructor !== undefined &&
      EventTargetConstructor !== undefined &&
      receiver instanceof EventTargetConstructor
    ) {
      // `addEventListener(type, listener)` only runs its listener once
      // something dispatches: the type it was registered under is sitting in
      // the argument list we just passed.
      for (const argument of args) {
        if (typeof argument !== "string" || argument === "") continue;
        try {
          receiver.dispatchEvent(new EventConstructor(argument, { bubbles: true }));
        } catch {
          /* not dispatchable; the verdict does not depend on it */
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  }

  /**
   * Benign arguments everywhere but the callback slot. Hostility belongs to the
   * fuzz gate; here a throwing argument only stops the member from reaching the
   * callback, which would turn a perfectly adjudicable member into a floor.
   */
  #tuplesFor(
    member: DomMember,
    paramIndex: number,
  ): readonly (readonly unknown[])[] | undefined {
    const pools: (readonly unknown[])[] = [];
    for (const [index, parameter] of (member.params ?? []).entries()) {
      if (index === paramIndex) {
        pools.push([undefined]);
        continue;
      }
      const values = parameter.types.map((type) => this.#arbitrary.valuesFor(type));
      const usable = values.filter(
        (pool): pool is readonly unknown[] => pool !== undefined && pool.length > 0,
      );
      if (usable.length === 0) {
        if (!parameter.optional) return undefined;
        pools.push([undefined]);
        continue;
      }
      // The fuzz pool leads with degenerate values because those refute. Here
      // they only stop the member from reaching its callback — and an event
      // type of `""` cannot be dispatched, which costs the `queued` verdict its
      // corroboration — so the ordinary value goes first.
      pools.push([...usable.flat()].sort(ordinaryFirst).slice(0, MAX_TUPLES));
    }

    return varyOnePosition(pools, { fixed: paramIndex }).slice(0, MAX_TUPLES);
  }
}

function ordinaryFirst(left: unknown, right: unknown): number {
  return degenerate(left) - degenerate(right);
}

function degenerate(value: unknown): number {
  return typeof value === "string" && value.trim() === "" ? 1 : 0;
}

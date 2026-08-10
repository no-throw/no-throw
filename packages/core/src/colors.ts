import type { BaselineSource } from "./baseline/data.js";

/**
 * Why a callee resolved to `throwing` with nothing to read. A floor has to say
 * which: "not yet analyzed" and "unknowable from here" are different problems
 * with different fixes, and the diagnostic is the only channel that carries the
 * difference.
 */
export type FloorReason =
  /** Declared with no body, and no carrier colors it. */
  | "bodyless"
  /** A visible body, but no mark — throwing by declaration, under `declare`. */
  | "unmarked"
  /** No declaration at all, so nothing could have colored it. */
  | "unresolvable"
  /**
   * Reached through a function captured from an enclosing scope. A condition
   * is a path over the function's *own* parameters, so a factory's inner
   * function has nothing a call site could discharge.
   */
  | "captured"
  /** A `let` or `var`: a real future refinement, not an unknowable. */
  | "mutable-binding"
  /**
   * Non-throwing only given conditions of its own. A hidden transfer reaches
   * its target through a type rather than being handed one, so no argument is
   * written at the site that could discharge them.
   */
  | "conditioned"
  /** A carrier answered, and what it said is that this one throws. */
  | "carried-throwing"
  /**
   * The package ships a manifest whose hashes no longer match its files, and
   * no surviving tag colors this. The diagnostic names the file that drifted.
   */
  | "stale-manifest"
  /** The package ships a manifest written for a wire version this cannot read. */
  | "unreadable-manifest"
  /**
   * It carries a `@nothrow` tag, and a valid manifest in the same package
   * supersedes tags package-wide without naming it. A different diagnosis from
   * "nothing colors it": the manifest is what is missing an entry.
   */
  | "superseded-tag"
  /**
   * A carrier claims this symbol with an entry this release cannot use — a
   * shape outside the schema, or a condition path with no engine form. The
   * fact it was stating is the one that would have made it clean.
   */
  | "unusable-entry"
  /**
   * A `lib.*.d.ts` member the baseline states no accessor fact for. The libs
   * declare real getters as plain properties, so the declaration is no oracle
   * there — and unlike a third-party `.d.ts`, an enumeration of them exists,
   * which is why they are not trust base. Absence therefore floors instead of
   * being read as "it is only a property".
   */
  | "no-accessor-fact";

/**
 * Where the declaration a floor is about lives, and — once it turns out to be
 * a first-party lib member — whether the baseline said anything about it.
 *
 * An out is only an out if the reader can reach it, and three of the four
 * cannot reach a `lib.*.d.ts`: an override and an overlay are keyed by npm
 * package name, and nobody owns TypeScript's libs to ship a manifest from. A
 * floor over one therefore names two outs rather than four, and the second of
 * them is us. The baseline is also the only rung that can answer for a lib
 * member at all, which is what lets the two lib cases be told apart by the
 * reason alone.
 */
export type FloorSource =
  /** An ordinary declaration; every rung of the chain can reach it. */
  | { readonly reach: "package" }
  | {
      readonly reach: "lib";
      /** Which of the two shipped baselines answers for it. */
      readonly baseline: BaselineSource;
      /**
       * Whether that baseline stated a color. Absence is a floor either way,
       * but only a color somebody wrote down is evidence a bridge is honest.
       */
      readonly stated: boolean;
    };

/**
 * Why a callee is throwing. `inferred` is the one answer that is not a floor:
 * the body was read and it can throw, so the outs a floor names — assert it,
 * overlay it, ship a manifest — would be silencing a true positive.
 */
export type ThrowingReason = FloorReason | "inferred";

/**
 * Why an argument failed to discharge the condition it was passed for. The
 * floor reasons carry over unchanged — the argument is a callee once the call
 * runs — and the rest are shapes only an argument has.
 */
export type UndischargedReason =
  | FloorReason
  /** The conditioned parameter got no argument, so there is none to read. */
  | "missing-argument"
  /** Propagating it would produce a path deeper than the engine follows. */
  | "beyond-depth";

/**
 * Why a promise can reject. Reject-ness rides our color and nothing else — a
 * rejecting and a non-rejecting `async` function have the identical type — so
 * everything a callee can be carries over, plus the shapes only a promise in
 * hand has.
 */
export type RejectionReason =
  | ThrowingReason
  /**
   * Nothing in the syntax names the call that produced it: a parameter, a
   * property, a non-call initializer, a stored partial chain.
   */
  | "untraced"
  /**
   * The producing call's callee is a parameter. A condition says calling it is
   * clean and has no form for "and the promise it hands back never rejects".
   */
  | "conditioned-producer"
  /**
   * A handler in the chain is reached through a parameter. Conditioning a chain
   * handler is a mechanism the engine does not have.
   */
  | "conditioned-handler";

/**
 * Whose color a rejection came from. A chain's color is a join over its head
 * and its handlers, so the reason alone does not say what to fix: telling a
 * reader to make "that producer" non-throwing when a handler is what throws
 * points them at something already clean.
 */
export type RejectionSubject =
  /** The promise value itself, where the syntax names no body to blame. */
  | "promise"
  /** The call at the head of the chain. */
  | "producer"
  /** A `then`, `catch` or `finally` handler. */
  | "handler";

/** Why a promise can reject, and what the reader has to look at. */
export interface Rejects {
  readonly reason: RejectionReason;
  readonly subject: RejectionSubject;
  /** The file whose hash drifted; only `stale-manifest` carries one. */
  readonly staleFile?: string | undefined;
  /** Absent where the subject is not a standard-library declaration. */
  readonly source?: FloorSource | undefined;
}

/**
 * Why consuming an iterator is throwing. Everything a callee can be carries
 * over — the protocol resolves to bodies like anything else, and a `let` is the
 * same deferred refinement here — plus the one shape only a produced value has:
 * the expression→originating-call rule naming no call at all.
 */
export type ConsumptionReason =
  | ThrowingReason
  /** Nothing in the syntax names the call that produced it. */
  | "untraced"
  /**
   * The producing call's callee is a parameter. A condition says calling it is
   * clean and has no form for "and consuming what it hands back is too", so
   * there is nothing a caller could discharge.
   */
  | "conditioned-producer";

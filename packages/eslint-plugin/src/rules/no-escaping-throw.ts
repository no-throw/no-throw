import {
  analyzeSourceFile,
  type ConsumptionReason,
  type EntrySite,
  type Finding,
  type FloorReason,
  type HiddenCallee,
  type RejectionReason,
  type Rejects,
  type RejectionSubject,
  type TransferSite,
  type UndischargedReason,
} from "@no-throw/core";
import {
  ESLintUtils,
  type TSESLint,
  type TSESTree,
} from "@typescript-eslint/utils";
import { relative, sep } from "node:path";
import type ts from "typescript";
import { bridgeEdit, type BridgeShape } from "../bridge.js";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/no-throw/no-throw#${name}`,
);

/**
 * The outs a floor must name, in precedence order. They live in the message
 * text and never behind a docs URL: the CI log is the channel that survives
 * into code review, and acting on a floor from it alone is the whole contract.
 */
const CARRIERS =
  "assert the color in `nothrow.overrides.json`; install or write an " +
  "`@no-throw/*` overlay; or, if you own the package, ship a manifest with " +
  "`nothrow emit`.";

/** The same rungs where what floored is something a *producer* colors. */
const PRODUCER_CARRIERS =
  "assert the producer's color in `nothrow.overrides.json`; install or write " +
  "an `@no-throw/*` overlay; or, if you own the package, ship a manifest with " +
  "`nothrow emit`.";

const outs = (what: string): string =>
  `Your outs, in precedence order: bridge this ${what} with \`try\`/\`catch\`; ` +
  CARRIERS;

const OUTS = outs("call");

/**
 * A returned iterator is consumed by the caller, so the bridge is not on this
 * side of the boundary. What is: naming the call that produced it.
 */
const RETURN_OUTS =
  "Your outs, in precedence order: return the iterator from a call this rule " +
  "can trace — a direct call, or a `const` initialized by one; " +
  PRODUCER_CARRIERS;

/**
 * The bridge for a rejection is the awaiting one. A `catch` that never awaits
 * is not on the path a rejection takes, so naming the plain `try`/`catch` here
 * would be naming the fake bridge as a remedy.
 */
const AWAIT_OUTS =
  "Your outs, in precedence order: bridge it with `try { await … } catch`; " +
  CARRIERS;

/**
 * A discarded promise is never awaited, so the bridge is a change of shape
 * rather than a wrapper — and the terminal `.catch(h)` is the other legal
 * form, which is the whole reason fire-and-forget has one at all.
 */
const FLOAT_OUTS =
  "Your outs, in precedence order: `await` it inside a `try`/`catch`; end the " +
  "chain with a `.catch(h)` whose handler is non-throwing; " +
  CARRIERS;

/** A returned promise is awaited by the caller, so the bridge is not here. */
const RETURN_PROMISE_OUTS =
  "Your outs, in precedence order: `await` it inside a `try`/`catch` and " +
  "return a value instead; " +
  PRODUCER_CARRIERS;

const diagnostics = {
  uncaughtThrow: "Uncaught `throw` escapes this `@nothrow` function.",
  unbridgedCall:
    "Call to `{{callee}}` escapes this `@nothrow` function: it {{reason}}. " +
    OUTS,
  // Not a floor, so not the floor's outs: the body was read and it can throw,
  // and every carrier on that list would be silencing a true positive.
  inferredThrowingCall:
    "Call to `{{callee}}` escapes this `@nothrow` function: its body was " +
    "analyzed and can throw. Your outs: bridge this call with `try`/`catch`, " +
    "or make `{{callee}}` non-throwing — mark it `@nothrow` and the escapes " +
    "inside it are reported too.",
  // A conditioned callee is clean given a path over its own parameters, so a
  // failure names the path, where the callee's body enters it, and the outs.
  conditionArgumentThrowing:
    "Call to `{{callee}}` escapes this `@nothrow` function: it is non-throwing " +
    "given `{{path}}`, and the argument passed for `{{path}}` is throwing — " +
    "its body was analyzed and can throw. `{{callee}}` enters `{{path}}` at " +
    "{{entry}}. Your outs: bridge this call with `try`/`catch`, or pass " +
    "something non-throwing for `{{path}}`.",
  conditionArgumentFloored:
    "Call to `{{callee}}` escapes this `@nothrow` function: it is non-throwing " +
    "given `{{path}}`, and {{reason}}. `{{callee}}` enters `{{path}}` at " +
    "{{entry}}. " + OUTS,
  // The same contract for a condition a carrier states. There is no body to
  // point the reader at, so what the second clause names instead is the claim:
  // a manifest, an overlay or an override said this, and it is discharged here.
  carriedConditionArgumentThrowing:
    "Call to `{{callee}}` escapes this `@nothrow` function: the carrier that " +
    "colors it declares it non-throwing given `{{path}}`, and the argument " +
    "passed for `{{path}}` is throwing — its body was analyzed and can throw. " +
    "Your outs: bridge this call with `try`/`catch`, or pass something " +
    "non-throwing for `{{path}}`.",
  carriedConditionArgumentFloored:
    "Call to `{{callee}}` escapes this `@nothrow` function: the carrier that " +
    "colors it declares it non-throwing given `{{path}}`, and {{reason}}. " +
    OUTS,
  unbridgedConsumption:
    "Consuming this iterator escapes this `@nothrow` function: {{reason}}. " +
    outs("consumption"),
  inferredThrowingConsumption:
    "Consuming this iterator escapes this `@nothrow` function: the body " +
    "producing its values was analyzed and can throw. Your outs: bridge this " +
    "consumption with `try`/`catch`, or make that producer non-throwing — " +
    "mark it `@nothrow` and the escapes inside it are reported too.",
  // No carrier can color this away, and no body can either: the value being
  // thrown is written right here.
  iteratorThrow:
    "`.throw()` escapes this `@nothrow` function: it throws the value into " +
    "the iterator, whatever the iterator makes of it — a throw cannot be " +
    "laundered through one. Bridge it with `try`/`catch`.",
  unprovableReturnedIterator:
    "This `@nothrow` function returns an iterator, so the mark covers " +
    "consuming it too: {{reason}}. " +
    RETURN_OUTS,
  inferredThrowingReturnedIterator:
    "This `@nothrow` function returns an iterator, so the mark covers " +
    "consuming it too: the body producing its values was analyzed and can " +
    "throw. Your outs: return an iterator from a non-throwing producer, or " +
    "make that producer non-throwing — mark it `@nothrow` and the escapes " +
    "inside it are reported too.",
  // `@nothrow` on a promise-producing function covers the rejection too, so
  // these are the three places the promise channel is consumed. Each says
  // something different: an `await` turns a rejection into a throw here, a
  // discard lets it reach nobody, and a `return` hands it on under this mark.
  unbridgedAwait:
    "Awaiting `{{expression}}` escapes this `@nothrow` function: {{reason}}. " +
    AWAIT_OUTS,
  inferredThrowingAwait:
    "Awaiting `{{expression}}` escapes this `@nothrow` function: {{reason}}. " +
    "Your outs: bridge it with `try { await … } catch`, or make {{culprit}} " +
    "non-throwing — mark it `@nothrow` and the escapes inside it are reported " +
    "too.",
  unprovableFloat:
    "`{{expression}}` is discarded, so nothing handles a rejection and Node " +
    "escalates one to an uncaught exception: {{reason}}. " +
    FLOAT_OUTS,
  inferredThrowingFloat:
    "`{{expression}}` is discarded, so nothing handles a rejection and Node " +
    "escalates one to an uncaught exception: {{reason}}. Your outs: `await` " +
    "it inside a `try`/`catch`, end the chain with a `.catch(h)` whose " +
    "handler is non-throwing, or make {{culprit}} non-throwing — mark it " +
    "`@nothrow` and the escapes inside it are reported too.",
  // Its own messageId whichever way the callee got its color: what the reader
  // has to be told first is that the `catch` they wrote cannot run, and the
  // edit that fixes that is the same either way. It names no carrier, because
  // a carrier could not have put the callee here — only a visibly-`async`
  // declaration this program can see reaches it.
  fakeBridge:
    "`{{expression}}` is `async`, so this `try`/`catch` can never fire: an " +
    "`async` function does not throw, it rejects, and a `catch` with no " +
    "`await` is not on that path. The promise is discarded here and " +
    "{{reason}}. Write `try { await … } catch` instead, or end the chain with " +
    "a `.catch(h)` whose handler is non-throwing.",
  unprovableReturnedPromise:
    "This `@nothrow` function returns a promise, so the mark covers its " +
    "rejection too: {{reason}}. " +
    RETURN_PROMISE_OUTS,
  inferredThrowingReturnedPromise:
    "This `@nothrow` function returns a promise, so the mark covers its " +
    "rejection too: {{reason}}. Your outs: `await` it inside a `try`/`catch` " +
    "and return a value instead, or make {{culprit}} non-throwing — mark it " +
    "`@nothrow` and the escapes inside it are reported too.",
  // Its own pair, because the first thing the reader needs told is that this
  // *is* a call: they did not write one, and the message has to say what runs.
  unbridgedHiddenTransfer:
    "{{site}} escapes this `@nothrow` function: {{reason}}. " + OUTS,
  inferredThrowingHiddenTransfer:
    "{{site}} escapes this `@nothrow` function: it runs {{target}}, whose " +
    "body was analyzed and can throw. Your outs: bridge it with " +
    "`try`/`catch`, or make {{target}} non-throwing — mark it `@nothrow` and " +
    "the escapes inside it are reported too.",
} as const;

/**
 * The labels an editor puts on the offered edits. They are the mechanical form
 * of the first out each message names, which is why there is one per bridge
 * shape and not one per diagnostic: the message above the list has already
 * said what "this" is.
 */
const offers = {
  suggestBridge: "Bridge this with `try`/`catch`.",
  suggestAwaitBridge: "Bridge this with `try { await … } catch`.",
  suggestAwait:
    "Add the missing `await`, so the `catch` is on the rejection's path.",
} as const;

const messages = { ...diagnostics, ...offers } as const;

type DiagnosticId = keyof typeof diagnostics;
type OfferId = keyof typeof offers;
type MessageId = keyof typeof messages;

interface Bridge {
  readonly shape: BridgeShape;
  readonly messageId: OfferId;
}

const BRIDGE: Bridge = { shape: "wrap", messageId: "suggestBridge" };

/** The `await` is written already, so wrapping produces the shape by itself. */
const BRIDGE_AN_EXISTING_AWAIT: Bridge = {
  shape: "wrap",
  messageId: "suggestAwaitBridge",
};

/** Nothing awaits it yet, so the edit is the one that writes the `await`. */
const BRIDGE_AND_ADD_THE_AWAIT: Bridge = {
  shape: "awaiting-wrap",
  messageId: "suggestAwaitBridge",
};

/** The `try` is there and cannot fire; only the `await` is missing. */
const ADD_THE_AWAIT: Bridge = { shape: "await", messageId: "suggestAwait" };

/**
 * What each diagnostic offers to do about itself. `undefined` is a decision,
 * not an omission: an offered edit is an offer to make the diagnostic go away,
 * so it is made only where a mechanical bridge really is the remedy. Where the
 * way out is something else — returning the error instead of throwing it,
 * returning an iterator from a producer this rule can trace, awaiting a
 * returned promise and returning a value in its place — the reader has to
 * write it, and an edit here would be offering to silence a true report.
 *
 * A diagnostic with no entry is a compile error, never a silent no-offer.
 */
const bridgeFor: Record<DiagnosticId, Bridge | undefined> = {
  uncaughtThrow: undefined,
  unbridgedCall: BRIDGE,
  inferredThrowingCall: BRIDGE,
  conditionArgumentThrowing: BRIDGE,
  conditionArgumentFloored: BRIDGE,
  carriedConditionArgumentThrowing: BRIDGE,
  carriedConditionArgumentFloored: BRIDGE,
  unbridgedConsumption: BRIDGE,
  inferredThrowingConsumption: BRIDGE,
  iteratorThrow: BRIDGE,
  unprovableReturnedIterator: undefined,
  inferredThrowingReturnedIterator: undefined,
  unbridgedAwait: BRIDGE_AN_EXISTING_AWAIT,
  inferredThrowingAwait: BRIDGE_AN_EXISTING_AWAIT,
  unprovableFloat: BRIDGE_AND_ADD_THE_AWAIT,
  inferredThrowingFloat: BRIDGE_AND_ADD_THE_AWAIT,
  fakeBridge: ADD_THE_AWAIT,
  unprovableReturnedPromise: undefined,
  inferredThrowingReturnedPromise: undefined,
  unbridgedHiddenTransfer: BRIDGE,
  inferredThrowingHiddenTransfer: BRIDGE,
};

/**
 * The carrier chain's own failures, as predicates over whatever the message
 * makes its subject. One clause each, reused across the four records below, so
 * a reader is told the same thing about a stale manifest whether it floored a
 * call, an argument, a consumption or a promise.
 */
const CARRIED_THROWING =
  "is colored `throwing` by the carrier that answers for it — a shipped " +
  "manifest, an overlay, an override, or the standard-library baseline — so " +
  "calling it can throw";

const UNREADABLE_MANIFEST =
  "ships in a package whose `nothrow.json` names a `version` this release " +
  "cannot read, so the whole manifest is ignored and nothing else colors it";

const SUPERSEDED_TAG =
  "carries a `@nothrow` tag that its package's own `nothrow.json` supersedes " +
  "— a valid manifest answers for the whole package — and that manifest has " +
  "no entry for it";

/**
 * #29 §4's control, as a sentence. The libs declare real getters as plain
 * properties, and an enumeration of which ones exists — that is precisely why
 * they are not trust base — so a member the baseline says nothing about is a
 * question with no answer rather than a property with no getter.
 */
const NO_ACCESSOR_FACT =
  "is declared as a plain property in a `lib.*.d.ts` that the shipped " +
  "standard-library baseline states no accessor fact for, and the libs declare " +
  "real getters as properties, so silence cannot be read as data";

const UNUSABLE_ENTRY =
  "is claimed by a carrier entry this release cannot use — a shape outside " +
  "the manifest schema, or a condition path with no form in this engine — so " +
  "the fact that would have colored it is not applied";

const staleManifest = (file: string): string =>
  "is colored by a `nothrow.json` that no longer matches its package's " +
  `files — \`${file}\` has changed since the manifest was written — so the ` +
  "manifest is ignored and no surviving `@nothrow` tag colors it either";

/** The one reason whose text needs a fact the record cannot hold. */
type StaticFloorReason = Exclude<FloorReason, "stale-manifest">;

/**
 * The why half of the two-clause floor contract, as a predicate: the call
 * messages make the callee its subject, the hidden-transfer ones the member
 * that runs. One record, so the normative text cannot drift between them.
 */
const whyFloored: Record<StaticFloorReason, string> = {
  bodyless:
    "is declared without a body — an ambient declaration, a `.d.ts`, or a " +
    "value known only by its function type — and no mark, manifest, overlay, " +
    "override or baseline entry colors it, so it is assumed to throw",
  unmarked:
    "has a visible body but no `@nothrow` mark, so it is throwing by " +
    "declaration",
  unresolvable:
    "cannot be resolved to a declaration by the checker, so nothing can say " +
    "whether it throws",
  captured:
    "is captured from an enclosing scope rather than reached through a " +
    "parameter of this function, so no argument at any call site could " +
    "discharge a condition on it",
  "mutable-binding":
    "is reached through a `let`, whose value the engine does not yet track " +
    "across assignments, so which function runs here is not settled",
  conditioned:
    "is non-throwing only given conditions of its own, and this site reaches " +
    "it through a type rather than handing it anything, so there is no " +
    "argument here that could discharge them",
  "carried-throwing": CARRIED_THROWING,
  "no-accessor-fact": NO_ACCESSOR_FACT,
  "unreadable-manifest": UNREADABLE_MANIFEST,
  "superseded-tag": SUPERSEDED_TAG,
  "unusable-entry": UNUSABLE_ENTRY,
};

/** The why clause for a callee, with the one fact a record cannot hold. */
function whyCalleeFloored(
  reason: FloorReason,
  staleFile: string | undefined,
): string {
  return reason === "stale-manifest"
    ? staleManifest(staleFile ?? "one of its files")
    : whyFloored[reason];
}

/** The same contract for the argument that was supposed to discharge a path. */
const whyUndischarged: Record<
  Exclude<UndischargedReason, "stale-manifest">,
  string
> = {
  bodyless:
    "the argument passed for it is declared without a body — an ambient " +
    "declaration, a `.d.ts`, or an interface member — and no mark, manifest, " +
    "overlay, override or baseline entry colors it",
  unmarked:
    "the argument passed for it has a visible body but no `@nothrow` mark, so " +
    "it is throwing by declaration",
  unresolvable:
    "the argument passed for it does not resolve to a function this engine " +
    "can color, so nothing can say whether it throws",
  captured:
    "the argument passed for it comes from an enclosing function's parameter, " +
    "which is unknowable from here",
  "mutable-binding":
    "the argument passed for it is a `let`, whose value the engine does not " +
    "yet track across assignments",
  conditioned:
    "the argument passed for it is itself non-throwing only given conditions " +
    "of its own, which no argument at this call site can discharge",
  "missing-argument":
    "no argument is passed for it, so there is nothing here to discharge it",
  "beyond-depth":
    "carrying it up to this function would make a path deeper than the engine " +
    "follows",
  "carried-throwing": `the argument passed for it ${CARRIED_THROWING}`,
  "no-accessor-fact": `the argument passed for it ${NO_ACCESSOR_FACT}`,
  "unreadable-manifest": `the argument passed for it ${UNREADABLE_MANIFEST}`,
  "superseded-tag": `the argument passed for it ${SUPERSEDED_TAG}`,
  "unusable-entry": `the argument passed for it ${UNUSABLE_ENTRY}`,
};

function whyArgumentUndischarged(
  reason: UndischargedReason,
  staleFile: string | undefined,
): string {
  return reason === "stale-manifest"
    ? `the argument passed for it ${staleManifest(staleFile ?? "one of its files")}`
    : whyUndischarged[reason];
}

/**
 * The why half of the floor contract for a consumption site. The subject is
 * the iterator rather than a named callee: what runs when you consume one is
 * the protocol, and the author wrote none of it.
 */
const whyConsumptionFloored: Record<
  Exclude<ConsumptionReason, "inferred" | "stale-manifest">,
  string
> = {
  bodyless:
    "what consuming it runs is declared without a body — an ambient or " +
    "`.d.ts` declaration, the standard library\'s iteration protocol among " +
    "them — and no mark, manifest, overlay, override or baseline entry colors " +
    "it, so it is " +
    "assumed to throw",
  unmarked:
    "what consuming it runs has a visible body but no `@nothrow` mark, so it " +
    "is throwing by declaration",
  unresolvable:
    "the checker cannot resolve what consuming it runs, so nothing can say " +
    "whether it throws",
  captured:
    "it is produced by a function captured from an enclosing scope, so no " +
    "argument at any call site could color what consuming it runs",
  "mutable-binding":
    "it reaches here through a `let`, whose value the engine does not yet " +
    "track across assignments, so which call produced it is not settled",
  untraced:
    "nothing in the syntax names the call that produced it, so nothing can " +
    "say whether consuming it throws",
  "conditioned-producer":
    "it is produced by a call to one of this function\'s own parameters, and " +
    "a condition can say that calling a parameter is clean but not that " +
    "consuming what it hands back is",
  conditioned:
    "what consuming it runs is non-throwing only given conditions of its own, " +
    "and consuming an iterator hands nothing over that could discharge them",
  "carried-throwing": `what consuming it runs ${CARRIED_THROWING}`,
  "no-accessor-fact": `what consuming it runs ${NO_ACCESSOR_FACT}`,
  "unreadable-manifest": `what consuming it runs ${UNREADABLE_MANIFEST}`,
  "superseded-tag": `what consuming it runs ${SUPERSEDED_TAG}`,
  "unusable-entry": `what consuming it runs ${UNUSABLE_ENTRY}`,
};

function whyConsumption(
  reason: Exclude<ConsumptionReason, "inferred">,
  staleFile: string | undefined,
): string {
  return reason === "stale-manifest"
    ? `what consuming it runs ${staleManifest(staleFile ?? "one of its files")}`
    : whyConsumptionFloored[reason];
}

/**
 * What a rejection message is *about*. A chain's color is a join over its head
 * and its handlers, so a reason on its own would send the reader to the wrong
 * body: `resolves().then(dirty)` is throwing because of `dirty`, and telling
 * them to mark `resolves` points at something already clean.
 */
const rejectionSubject: Record<RejectionSubject, string> = {
  promise: "the promise",
  producer: "the call that produced it",
  handler: "a handler in the chain",
};

/** What to make non-throwing, for the messages that are not floors. */
const rejectionCulprit: Record<RejectionSubject, string> = {
  // A promise the syntax names no body for always floors, so this side of the
  // record is only ever reached by way of the type.
  promise: "that producer",
  producer: "that producer",
  handler: "that handler",
};

/**
 * The why half of the contract for a promise, as a predicate over the subject
 * above. `inferred` is in the record rather than beside it because the fake
 * bridge carries one messageId for both halves: what the reader must act on
 * there is the shape of the `catch`, not how the callee got its color.
 *
 * The two floors #12 §7 singles out are the `let` and everything else, and the
 * text is where the difference has to live: one is a refinement this engine
 * has not made yet, the other is unknowable from here.
 */
const whyRejects: Record<Exclude<RejectionReason, "stale-manifest">, string> = {
  inferred: "has a body that was analyzed and can throw",
  bodyless:
    "is declared without a body — an ambient declaration, a `.d.ts`, or a " +
    "value known only by its function type — and no mark, manifest, overlay, " +
    "override or baseline entry colors it, so it is assumed to reject",
  unmarked:
    "has a visible body but no `@nothrow` mark, so it is throwing by " +
    "declaration",
  unresolvable:
    "does not resolve to a function this engine can color, so nothing can say " +
    "whether it rejects",
  captured:
    "is captured from an enclosing scope, so no argument at any call site " +
    "could color it",
  "mutable-binding":
    "is reached through a `let`, whose value the engine does not yet track " +
    "across assignments — a refinement not yet made rather than something " +
    "unknowable from here",
  conditioned:
    "is non-throwing only given conditions of its own, and nothing here hands " +
    "it an argument that could discharge them",
  untraced:
    "is named by no call in the syntax, and a parameter, a property, a " +
    "non-call initializer or a stored partial chain is unknowable from here",
  "conditioned-producer":
    "comes from a call to one of this function\'s own parameters, and a " +
    "condition can say that calling a parameter is clean but not that the " +
    "promise it hands back never rejects",
  "conditioned-handler":
    "is reached through a parameter of this function, and a chain handler is " +
    "not something a call site can discharge",
  "carried-throwing":
    "is colored `throwing` by the carrier that answers for it — a shipped " +
    "manifest, an overlay, an override, or the standard-library baseline — so " +
    "the promise it hands back can reject",
  "no-accessor-fact": NO_ACCESSOR_FACT,
  "unreadable-manifest": UNREADABLE_MANIFEST,
  "superseded-tag": SUPERSEDED_TAG,
  "unusable-entry": UNUSABLE_ENTRY,
};

/** The why clause — who, then what is wrong with them — and what to fix. */
function rejectionData(rejects: Rejects): {
  readonly reason: string;
  readonly culprit: string;
} {
  const { reason, subject, staleFile } = rejects;
  const why =
    reason === "stale-manifest"
      ? staleManifest(staleFile ?? "one of its files")
      : whyRejects[reason];
  return {
    reason: `${rejectionSubject[subject]} ${why}`,
    culprit: rejectionCulprit[subject],
  };
}

/** The site, as the reader wrote it. */
const describeSite: Record<TransferSite, (text: string) => string> = {
  read: (text) => `Reading \`${text}\``,
  write: (text) => `Writing \`${text}\``,
  update: (text) => `Updating \`${text}\``,
  destructure: (text) => `Destructuring \`${text}\``,
  spread: (text) => `Spreading \`${text}\``,
  coercion: (text) => `Coercing \`${text}\` to a primitive`,
  "instance-check": (text) => `Checking \`${text}\``,
};

function describeTarget(target: HiddenCallee): string {
  return `the ${target.kind} \`${target.name}\``;
}

type Report =
  | { readonly messageId: "uncaughtThrow" | "iteratorThrow" }
  | {
      readonly messageId: "unbridgedCall";
      readonly data: { readonly callee: string; readonly reason: string };
    }
  | {
      readonly messageId: "inferredThrowingCall";
      readonly data: { readonly callee: string };
    }
  | {
      readonly messageId: "conditionArgumentThrowing";
      readonly data: {
        readonly callee: string;
        readonly path: string;
        readonly entry: string;
      };
    }
  | {
      readonly messageId: "conditionArgumentFloored";
      readonly data: {
        readonly callee: string;
        readonly path: string;
        readonly entry: string;
        readonly reason: string;
      };
    }
  | {
      readonly messageId: "carriedConditionArgumentThrowing";
      readonly data: { readonly callee: string; readonly path: string };
    }
  | {
      readonly messageId: "carriedConditionArgumentFloored";
      readonly data: {
        readonly callee: string;
        readonly path: string;
        readonly reason: string;
      };
    }
  | {
      readonly messageId: "unbridgedConsumption" | "unprovableReturnedIterator";
      readonly data: { readonly reason: string };
    }
  | {
      readonly messageId:
        | "inferredThrowingConsumption"
        | "inferredThrowingReturnedIterator";
    }
  | {
      readonly messageId:
        | "unbridgedAwait"
        | "inferredThrowingAwait"
        | "unprovableFloat"
        | "inferredThrowingFloat"
        | "fakeBridge";
      readonly data: {
        readonly expression: string;
        readonly reason: string;
        readonly culprit: string;
      };
    }
  | {
      readonly messageId:
        | "unprovableReturnedPromise"
        | "inferredThrowingReturnedPromise";
      readonly data: { readonly reason: string; readonly culprit: string };
    }
  | {
      readonly messageId: "unbridgedHiddenTransfer";
      readonly data: { readonly site: string; readonly reason: string };
    }
  | {
      readonly messageId: "inferredThrowingHiddenTransfer";
      readonly data: { readonly site: string; readonly target: string };
    };

/**
 * The whole invariant is one rule, so every escape the core reports has to land
 * on a message inside it. A finding kind with no `case` here stops returning a
 * `Report` on every path, which is a compile error.
 */
function reportFor(finding: Finding, cwd: string): Report {
  switch (finding.kind) {
    case "uncaught-throw":
      return { messageId: "uncaughtThrow" };
    case "unbridged-call":
      return {
        messageId: "unbridgedCall",
        data: {
          callee: finding.callee,
          reason: whyCalleeFloored(finding.reason, finding.staleFile),
        },
      };
    case "inferred-throwing-call":
      return {
        messageId: "inferredThrowingCall",
        data: { callee: finding.callee },
      };
    case "throwing-condition-argument":
      // A condition a carrier states has no body behind it, so the clause that
      // would point at one is replaced rather than filled with a guess.
      return finding.entry === undefined
        ? {
            messageId: "carriedConditionArgumentThrowing",
            data: { callee: finding.callee, path: finding.path },
          }
        : {
            messageId: "conditionArgumentThrowing",
            data: {
              callee: finding.callee,
              path: finding.path,
              entry: entryText(finding.entry, cwd),
            },
          };
    case "floored-condition-argument": {
      const reason = whyArgumentUndischarged(finding.reason, finding.staleFile);
      return finding.entry === undefined
        ? {
            messageId: "carriedConditionArgumentFloored",
            data: { callee: finding.callee, path: finding.path, reason },
          }
        : {
            messageId: "conditionArgumentFloored",
            data: {
              callee: finding.callee,
              path: finding.path,
              entry: entryText(finding.entry, cwd),
              reason,
            },
          };
    }
    case "throwing-consumption":
      return finding.reason === "inferred"
        ? { messageId: "inferredThrowingConsumption" }
        : {
            messageId: "unbridgedConsumption",
            data: {
              reason: whyConsumption(finding.reason, finding.staleFile),
            },
          };
    case "iterator-throw":
      return { messageId: "iteratorThrow" };
    case "throwing-returned-iterator":
      return finding.reason === "inferred"
        ? { messageId: "inferredThrowingReturnedIterator" }
        : {
            messageId: "unprovableReturnedIterator",
            data: {
              reason: whyConsumption(finding.reason, finding.staleFile),
            },
          };
    case "rejected-await":
      return {
        messageId:
          finding.rejects.reason === "inferred"
            ? "inferredThrowingAwait"
            : "unbridgedAwait",
        data: {
          expression: finding.expression,
          ...rejectionData(finding.rejects),
        },
      };
    case "floating-rejection":
      return {
        messageId: finding.fake
          ? "fakeBridge"
          : finding.rejects.reason === "inferred"
            ? "inferredThrowingFloat"
            : "unprovableFloat",
        data: {
          expression: finding.expression,
          ...rejectionData(finding.rejects),
        },
      };
    case "rejected-return":
      return {
        messageId:
          finding.rejects.reason === "inferred"
            ? "inferredThrowingReturnedPromise"
            : "unprovableReturnedPromise",
        data: rejectionData(finding.rejects),
      };
    case "unbridged-hidden-transfer":
      return {
        messageId: "unbridgedHiddenTransfer",
        data: {
          site: describeSite[finding.site](finding.text),
          reason:
            finding.target === undefined
              ? `the checker cannot resolve \`${finding.text}\` to a ` +
                "declaration, so nothing can say whether a body runs here"
              : `it runs ${describeTarget(finding.target)}, which ` +
                whyCalleeFloored(finding.reason, finding.staleFile),
        },
      };
    case "inferred-throwing-hidden-transfer":
      return {
        messageId: "inferredThrowingHiddenTransfer",
        data: {
          site: describeSite[finding.site](finding.text),
          target: describeTarget(finding.target),
        },
      };
  }
}

/**
 * Where the callee's body enters the path, as a place a reader can open. The
 * core reports an absolute file name because it has no notion of a project
 * root; the adapter has one, and printing paths is not analysis.
 */
function entryText(entry: EntrySite, cwd: string): string {
  const path = relative(cwd, entry.fileName).split(sep).join("/");
  return `${path}:${entry.line}`;
}

/**
 * The offer, where there is one to make. It is never a `fix`: wrapping a call
 * in a bridge changes what the program does with an error, and a tool may not
 * make that choice on the reader's behalf — `--fix` would rewrite a whole
 * codebase into one that swallows everything and reports nothing.
 */
function offerFor(
  messageId: DiagnosticId,
  node: TSESTree.Node | undefined,
  source: string,
): TSESLint.ReportSuggestionArray<MessageId> | undefined {
  const bridge = bridgeFor[messageId];
  if (bridge === undefined || node === undefined) return undefined;

  const edit = bridgeEdit(node, bridge.shape, source);
  if (edit === undefined) return undefined;

  return [
    {
      messageId: bridge.messageId,
      fix: (fixer) => fixer.replaceTextRange(edit.range, edit.text),
    },
  ];
}

export const noEscapingThrow = createRule<[], MessageId>({
  name: "no-escaping-throw",
  meta: {
    type: "problem",
    docs: {
      description: "Enforce that no throw escapes a function marked `@nothrow`.",
    },
    hasSuggestions: true,
    messages,
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);

    return {
      // The whole file goes to the core in one piece: deciding which nodes are
      // candidate marks is analysis, and the adapter does none.
      Program(node: TSESTree.Program): void {
        const sourceFile = services.esTreeNodeToTSNodeMap.get(
          node,
        ) as ts.SourceFile;
        const source = context.sourceCode.getText();

        for (const finding of analyzeSourceFile(sourceFile, services.program)) {
          const reportAt = services.tsNodeToESTreeNodeMap.get(finding.node);
          const report = reportFor(finding, context.cwd);
          const suggest = offerFor(report.messageId, reportAt, source);

          context.report({
            node: reportAt ?? node,
            ...report,
            ...(suggest === undefined ? {} : { suggest }),
          });
        }
      },
    };
  },
});

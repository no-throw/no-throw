import type { Hazard } from "./spec/extract.js";

/**
 * Hazards key on the **shape of the throw condition**, never on the root
 * abstract operation's name. That is a soundness requirement, not a coverage
 * one: an op-name enum fails *silently in the unsafe direction* when a name is
 * misfiled, which is exactly what shipped six unsound `Atomics.*` entries.
 * A condition-shape rule reads the range check off the prose and cannot make
 * that mistake.
 *
 * Reading the condition also stops the residue being a treadmill — the same
 * handful of reasons account for hundreds of operations.
 */
export type Domain =
  | "callable"
  | "constructor"
  | "non-nullish"
  | "coercible"
  | "primitive"
  | "object"
  | "string"
  | "symbol"
  | "brand"
  | "buffer-kind";

export type ShapeId =
  | "species"
  | "iterator"
  | "usercall"
  | "proxy"
  | "detach"
  | "callable"
  | "ctor"
  | "newtarget"
  | "nullish"
  | "symbolic"
  | "notObject"
  | "notString"
  | "notSymbol"
  | "weakly"
  | "shared"
  | "brand"
  | "isRegExp"
  | "enumVal"
  | "propertyKey"
  | "range"
  | "parse"
  | "state"
  | "mutation"
  | "coerce"
  | "toObject"
  | "unknown";

interface ShapeRule {
  readonly id: ShapeId;
  readonly test: RegExp;
  /** `root` rules match the operation the throw is written in. */
  readonly on?: "root";
  readonly domain?: Domain;
}

const RULES: readonly ShapeRule[] = [
  // Reaches user code.
  {
    id: "species",
    on: "root",
    test: /\b(SpeciesConstructor|ArraySpeciesCreate|TypedArraySpeciesCreate|TypedArrayCreateFromConstructor)\b/,
  },
  {
    id: "iterator",
    on: "root",
    test: /^(GetIterator|GetIteratorFromMethod|IteratorNext|IteratorStep|IteratorStepValue|IteratorValue|IteratorClose|IteratorToList|IterableToList|AddEntriesFromIterable|CreateListFromArrayLike|GetSetRecord|CreateDisposableResource)$/,
  },
  {
    id: "usercall",
    on: "root",
    test: /^(Call|Construct|\[\[Construct\]\]|GetMethod|FindViaPredicate|GroupBy|Invoke)$/,
  },
  // Buffer state.
  {
    id: "detach",
    test: /IsDetachedBuffer|IsTypedArrayOutOfBounds|IsViewOutOfBounds|IsArrayBufferViewOutOfBounds|is detached|ArrayBufferCopyAndDetach|arrayBuffer[^.]{0,40}detached/i,
  },

  // Guards a declared type may or may not discharge.
  { id: "callable", test: /IsCallable\([^)]+\) is false/, domain: "callable" },
  { id: "ctor", test: /IsConstructor\([^)]+\) is false/, domain: "constructor" },
  { id: "newtarget", test: /NewTarget is (not )?undefined/ },
  {
    id: "nullish",
    test: /is either undefined or null|RequireObjectCoercible/,
    domain: "non-nullish",
  },
  {
    id: "symbolic",
    test: /is a Symbol\b|is either a Symbol or a BigInt|is a BigInt\b/,
    domain: "coercible",
  },
  { id: "notObject", test: /is not an Object\b|is not an object\b/, domain: "object" },
  { id: "notString", test: /is not a String\b/, domain: "string" },
  { id: "notSymbol", test: /is not a Symbol\b/, domain: "symbol" },
  { id: "weakly", test: /CanBeHeldWeakly\(\w+\) is false/, domain: "object" },
  {
    id: "shared",
    test: /IsSharedArrayBuffer\(\w+\) is (true|false)/,
    domain: "buffer-kind",
  },
  {
    id: "brand",
    test: /RequireInternalSlot|does not have an? \[\[|Validate(TypedArray|IntegerTypedArray|NonRevokedProxy)\b|This(Number|String|BigInt|Time|Symbol|Boolean)Value|IsPromise\(\w+\) is false|IsRegExp/,
    domain: "brand",
  },
  { id: "isRegExp", test: /isRegexp is true|IsRegExp\(\w+\)/, domain: "string" },
  { id: "enumVal", test: /is not one of "/ },

  // Values a declared type does not bound.
  {
    id: "range",
    test: /\b(is|are) not in the inclusive interval|[<>≥≤]|= *[-+]∞|IsValidIntegerIndex|ToIndex|GetViewValue|SetViewValue|ValidateAtomicAccess|RevalidateAtomicAccess|is not an integral Number|is not finite|is NaN\b|SameValueZero\(|cannot be represented|Data Block|2(32|53|53 - 1)\b|\bnumberIndex\b/,
  },
  {
    id: "parse",
    test: /is not a valid JSON text|List of errors|throw a SyntaxError|SyntaxError exception|URIError|contains any code unit other than|Decode|Encode|RegExpInitialize|CreateDynamicFunction|PerformEval|ParseJSON/i,
  },
  {
    id: "state",
    test: /is disposed|initialValue is not present|kPresent is false|status is false|is not present\b|already|revoked|is empty\b|\[\[ContentType\]\]|AgentCanSuspend\(\)/,
  },
  {
    id: "mutation",
    on: "root",
    test: /^(Set|CreateDataPropertyOrThrow|DefinePropertyOrThrow|DeletePropertyOrThrow|SetIntegrityLevel|CreateMethodProperty|ArrayCreate|FlattenIntoArray|ArraySetLength|AddValueToKeyedGroup)$/,
  },
  // A property key may be *any* primitive — `o[sym]` is not a coercion hazard —
  // so this one discharges wider than the numeric and string coercions do.
  { id: "propertyKey", on: "root", test: /^ToPropertyKey$/, domain: "primitive" },
  {
    id: "coerce",
    on: "root",
    test: /^(ToNumber|ToString|ToPrimitive|ToIntegerOrInfinity|ToLength|ToNumeric|ToBigInt|StringToBigInt|ToUint32|ToInt32|NumberToBigInt|OrdinaryToPrimitive)$/,
    domain: "coercible",
  },
  {
    id: "toObject",
    on: "root",
    test: /^(ToObject|RequireObjectCoercible)$/,
    domain: "non-nullish",
  },
];

export interface Shape {
  readonly id: ShapeId;
  readonly domain: Domain | undefined;
  readonly rootOp: string;
  readonly condition: string;
}

/**
 * A property access dispatches through an object's internal methods, and a
 * `Proxy` overrides every one of them. Everything a trap can reach is
 * therefore the trap's behaviour, whichever operation the throw is finally
 * written in — so the *chain* decides this shape, not the deepest operation.
 *
 * #14 already ruled traps into the trust base: a Proxy is type-identical to
 * its target, so "might this be a Proxy?" has no static answer for any object
 * and flooring on it would colour nothing.
 *
 * Only the internal methods themselves qualify. The abstract operations that
 * *call* them — `GetV` coerces first, `RegExpExec` checks a user-supplied
 * `exec`'s result, `OrdinaryHasInstance` checks `C.prototype` — have throws of
 * their own that are nothing to do with a trap, and swallowing those is
 * unsound. Their trap-derived causes still carry an internal method in the
 * chain, so nothing is lost by naming this set narrowly.
 */
const TRAP_DISPATCH = /^\[\[\w+\]\]$/;

export function shapeOf(hazard: Hazard): Shape {
  const rootOp = hazard.rootOp === "EXPLICIT" ? "EXPLICIT" : hazard.rootOp;
  const condition = hazard.condition;

  if ([...hazard.via, rootOp].some((op) => TRAP_DISPATCH.test(op))) {
    return { id: "proxy", domain: undefined, rootOp, condition };
  }

  for (const rule of RULES) {
    const subject = rule.on === "root" ? rootOp : condition;
    if (rule.test.test(subject)) {
      return { id: rule.id, domain: rule.domain, rootOp, condition };
    }
    // An op-name rule also fires when the condition prose names the operation.
    if (rule.on === "root" && rule.test.test(condition)) {
      return { id: rule.id, domain: rule.domain, rootOp, condition };
    }
  }
  // A condition-keyed rule may still describe the operation a bare explicit
  // throw sits in.
  for (const rule of RULES) {
    if (rule.on !== "root" && rule.test.test(rootOp)) {
      return { id: rule.id, domain: rule.domain, rootOp, condition };
    }
  }
  return { id: "unknown", domain: undefined, rootOp, condition };
}

import { CONSTRUCT_SEGMENT, type DomMember } from "@no-throw/core/baseline";

import type { IdlCorpus, IdlRow } from "./idl/corpus.js";

/**
 * How a declared member is shaped at runtime, when something other than prose
 * answers it. These are #29's third accessor oracle — the structural rules —
 * and they exist because the first two oracles are silent on exactly the parts
 * of `lib.dom.d.ts` that are generated rather than written.
 */
export type Structure =
  /** An IDL `interface`/`namespace` member: attribute, operation or constant. */
  | "idl"
  /** A member of an IDL `dictionary`: a plain object literal at runtime. */
  | "dictionary"
  /** `HTMLElementTagNameMap` and friends — TypeScript inventions, type-level only. */
  | "ts-map"
  /** One of `CSSStyleDeclaration`'s generated CSS-property attributes. */
  | "cssom-generated"
  /** Declared by TypeScript with nothing behind it in IDL. */
  | "unmatched";

export interface JoinedMember {
  readonly member: DomMember;
  readonly idl: IdlRow | undefined;
  readonly structure: Structure;
}

export interface JoinReport {
  readonly joined: readonly JoinedMember[];
  readonly counts: Readonly<Record<Structure, number>>;
}

/** TypeScript's own type-level lookup tables; no runtime object corresponds. */
const TS_MAP_OWNER = /(EventMap|TagNameMap)$/;

/**
 * CSSOM declares its ~500 CSS-property attributes with a *placeholder*
 * (`_camel_cased_attribute`), so they can never match by name. They are still
 * IDL attributes — real accessors — and the owner is the rule.
 */
const CSSOM_GENERATED_OWNER = /^CSSStyle(Declaration|Properties)$/;

/** Which interface really owns a member at runtime, when this engine has it. */
export type RuntimeOwner = (member: DomMember) => string | undefined;

export function joinToIdl(
  members: readonly DomMember[],
  corpus: IdlCorpus,
  bases: ReadonlyMap<string, readonly string[]> = new Map(),
  runtimeOwner: RuntimeOwner = () => undefined,
): JoinReport {
  const joined = members.map((member) => {
    const idl = idlRowFor(member, corpus, bases, runtimeOwner);
    return { member, idl, structure: structureOf(member, idl, corpus) };
  });

  const counts: Record<Structure, number> = {
    idl: 0,
    dictionary: 0,
    "ts-map": 0,
    "cssom-generated": 0,
    unmatched: 0,
  };
  for (const entry of joined) counts[entry.structure]++;
  return { joined, counts };
}

function structureOf(
  member: DomMember,
  idl: IdlRow | undefined,
  corpus: IdlCorpus,
): Structure {
  if (corpus.dictionaries.has(member.owner)) return "dictionary";
  if (TS_MAP_OWNER.test(member.owner)) return "ts-map";
  if (idl !== undefined) return "idl";
  if (CSSOM_GENERATED_OWNER.test(member.owner) && member.kind === "property") {
    return "cssom-generated";
  }
  return "unmatched";
}

function idlRowFor(
  member: DomMember,
  corpus: IdlCorpus,
  bases: ReadonlyMap<string, readonly string[]>,
  runtimeOwner: RuntimeOwner,
): IdlRow | undefined {
  const wanted =
    member.name === CONSTRUCT_SEGMENT ? "constructor" : member.name;
  for (const owner of candidateOwners(member, corpus, bases, runtimeOwner)) {
    const rows = corpus.byMember.get(`${owner}.${wanted}`);
    if (rows === undefined) continue;
    const fit = rows.filter((row) => fits(member, row));
    const chosen = fit[0] ?? (member.isStatic ? undefined : rows[0]);
    if (chosen !== undefined) return chosen;
  }
  return undefined;
}

/**
 * A global function is an operation of whichever global interface declares it;
 * `lib.dom.d.ts` flattens all of them onto the module scope, so the owner has
 * to be guessed back from the small set of globals that exist.
 */
const GLOBALS = [
  "Window",
  "WindowOrWorkerGlobalScope",
  "WorkerGlobalScope",
  "DedicatedWorkerGlobalScope",
  "GlobalEventHandlers",
  "WindowEventHandlers",
  "AnimationFrameProvider",
];

export function candidateOwners(
  member: DomMember,
  corpus: IdlCorpus,
  bases: ReadonlyMap<string, readonly string[]>,
  runtimeOwner: RuntimeOwner = () => undefined,
): readonly string[] {
  const runtime = runtimeOwner(member);
  if (member.owner === "globalThis") {
    return runtime === undefined ? GLOBALS : [...GLOBALS, runtime];
  }
  // `declare var Element: { … }` is the constructor object for `interface
  // Element`, so the IDL owner is the same name on both sides; static-ness is
  // what tells the two apart, and `fits` checks it.
  const owners = [member.owner];
  // `interface NodeListOf<T> extends NodeList` is a TypeScript invention for
  // element typing, and it redeclares members. Without the fallback,
  // `nodes.item(0)` on a `NodeListOf` would floor while `NodeList#item` does not.
  const generic = /^(\w+)Of$/.exec(member.owner)?.[1];
  if (generic !== undefined) owners.push(generic);
  // `namespace console` against TypeScript's `interface Console`.
  const cased = corpus.interfacesByLowerName.get(member.owner.toLowerCase());
  if (cased !== undefined) owners.push(cased);
  // `interface Element` restates `addEventListener` so its typed event map can
  // narrow the listener, and the restatement is what every call site resolves
  // to. WebIDL declares it once, on `EventTarget`, and forbids a subinterface
  // from redeclaring it — so the base is not a guess, it is the definition. An
  // instance member never falls back this way for the *static* side, which is a
  // separate object with no inheritance of its own.
  if (!member.isStatic) owners.push(...(bases.get(member.owner) ?? []));
  // Last, because a declared answer beats an observed one where both exist:
  // `GlobalEventHandlers` restates `addEventListener` and `extends` nothing, so
  // only the prototype chain leads back to `EventTarget`.
  if (runtime !== undefined) owners.push(runtime);
  return owners;
}

function fits(member: DomMember, row: IdlRow): boolean {
  if (member.name === CONSTRUCT_SEGMENT) return row.kind === "constructor";
  // An IDL constant is reachable from both the instance and the constructor, so
  // it fits either side; everything else has to agree on static-ness.
  if (row.kind === "const") return true;
  if (member.owner === "globalThis") return true;
  return row.isStatic === member.isStatic;
}

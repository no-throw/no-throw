import type { AccessorFact, Color, DomMember } from "@nothrow/core/baseline";

import type { JoinedMember } from "./join.js";
import type { Proposal } from "./classify.js";
import { receiverFor, type DomEnvironment } from "./gates/environment.js";

/**
 * The largest single soundness item either baseline spike turned up (#26 §2,
 * #29). Every WebIDL `attribute` is a getter/setter pair on the prototype, and
 * `lib.dom.d.ts` declares **2,552 of 2,576** of them as a plain
 * `PropertySignature`. A browser probe found 898 of them to be real accessors
 * and **not one** to be a data property. So #14's hidden-transfer rule, read
 * against the declaration alone, concludes DOM property access is free — while
 * `input.selectionStart`, `request.result` and `location.href` are getter calls
 * that throw.
 *
 * Declaration shape is therefore not an oracle. Three others are, and they
 * combine in the safe direction — *any* of them saying accessor makes it one:
 *
 * 1. **The WebIDL kind.** `attribute` is an accessor; `const` is a
 *    non-writable data property.
 * 2. **`getOwnPropertyDescriptor` on a live receiver**, walking the prototype
 *    chain, in the same engine the fuzz gate runs in.
 * 3. **The structural rules**, for the parts of `lib.dom.d.ts` that are
 *    generated rather than written and that the first two are silent on:
 *    WebGL's constant tables, CSSOM's ~500 generated CSS-property attributes,
 *    and TypeScript's invented map interfaces.
 *
 * A member no oracle can see gets **no fact and therefore floors** — which is
 * exactly why the safe members carry a positive `accessor: false` record rather
 * than relying on silence (#29 §4).
 */

export type AccessorSource = "idl" | "runtime" | "structural" | "declaration";

export interface AccessorRecord {
  readonly key: string;
  readonly fact: AccessorFact;
  readonly sources: readonly AccessorSource[];
  /**
   * The fact describes a non-writable *data* property, not a getter. Reading
   * one runs no code, so there is no algorithm for the gate to refute and the
   * unprobed rule does not apply — WebIDL defines a `const` as a non-writable,
   * non-configurable data property, which is a structural guarantee rather than
   * a classification that could be wrong.
   */
  readonly dataProperty: boolean;
}

export function accessorFactFor(
  entry: JoinedMember,
  proposal: Proposal,
  environment: DomEnvironment,
  implementers: ReadonlyMap<string, readonly string[]>,
): AccessorRecord | undefined {
  const { member, idl, structure } = entry;
  // Calling or constructing is not a property access, so there is no accessor
  // question to answer.
  if (member.kind === "method" || member.kind === "construct" || member.kind === "call") {
    return undefined;
  }
  if (member.kind === "function") return undefined;

  const sources: AccessorSource[] = [];
  const descriptor = liveDescriptor(member, environment, implementers);

  if (member.declaredAccessor) sources.push("declaration");
  if (idl?.kind === "attribute") sources.push("idl");
  if (descriptor !== undefined && (descriptor.get !== undefined || descriptor.set !== undefined)) {
    sources.push("runtime");
  }
  if (structure === "cssom-generated") sources.push("structural");

  if (sources.length > 0) {
    return {
      key: member.key,
      fact: { get: getColor(proposal), set: "throwing" },
      sources,
      dataProperty: false,
    };
  }

  // A WebIDL constant is a real data property, and a non-writable one. Reading
  // it runs no code at all, so it is data — and `accessor: false` is the
  // positive record that says so.
  //
  // Assigning to one throws in strict mode, and that is deliberately *not*
  // coloured. Where TypeScript declares the member `readonly` the assignment is
  // a compile error, so a type-checked program cannot reach the throw; where it
  // does not, the write is still type-legal and gets the fact's `set` half.
  // Either way the throw is a programmer-bug `TypeError`, which #30's Out of
  // Scope rules out of the colour model, and no control is transferred, so it
  // is not an escape site under §C.
  if (idl?.kind === "const" || descriptor?.writable === false) {
    const source: AccessorSource = idl?.kind === "const" ? "idl" : "runtime";
    return member.readonlyModifier
      ? { key: member.key, fact: false, sources: [source], dataProperty: true }
      : {
          key: member.key,
          fact: { get: "non-throwing", set: "throwing" },
          sources: [source],
          dataProperty: true,
        };
  }

  // A dictionary is an object literal at the call site and TypeScript's map
  // interfaces are type-level fictions with no runtime object at all; in both
  // cases a read is a read, not a call.
  if (structure === "dictionary" || structure === "ts-map") {
    return { key: member.key, fact: false, sources: ["structural"], dataProperty: true };
  }

  if (descriptor !== undefined) {
    return { key: member.key, fact: false, sources: ["runtime"], dataProperty: true };
  }

  return undefined;
}

/**
 * The getter's colour, from the member's prose. `set` is never clean: there is
 * no write probe, because assigning to a shared receiver would corrupt every
 * later probe, and an unprobed clean claim floors. That is also exactly what
 * #29 §1 asks for — reading `location.href` costs nothing, assigning to it
 * needs the bridge.
 */
function getColor(proposal: Proposal): Color {
  if (proposal.color === undefined) return "throwing";
  const reaches = proposal.sites.some(
    (site) => site.verdict !== "type-excluded" && site.phase !== "set",
  );
  return reaches ? "throwing" : "non-throwing";
}

function liveDescriptor(
  member: DomMember,
  environment: DomEnvironment,
  implementers: ReadonlyMap<string, readonly string[]>,
): PropertyDescriptor | undefined {
  const receiver = holderFor(member, environment, implementers);
  if (receiver === null || receiver === undefined) return undefined;
  // Up the prototype chain: an attribute is defined on the interface prototype
  // the receiver inherits from, and the question is about the property as
  // reached from the receiver, not about where it happens to live.
  for (let current: object | null = receiver as object; current !== null; ) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(current, member.name);
      if (descriptor !== undefined) return descriptor;
      current = Object.getPrototypeOf(current) as object | null;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function holderFor(
  member: DomMember,
  environment: DomEnvironment,
  implementers: ReadonlyMap<string, readonly string[]>,
): unknown {
  if (member.owner === "globalThis") return environment.window;
  if (member.isStatic) {
    try {
      return (environment.window as unknown as Record<string, unknown>)[member.owner];
    } catch {
      return undefined;
    }
  }
  return receiverFor(environment, member.owner, implementers);
}

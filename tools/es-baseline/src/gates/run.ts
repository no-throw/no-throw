import { parseConditionPath } from "@no-throw/core/baseline";
import type { BaselineData, LibMember, LibProgram } from "@no-throw/core/baseline";

import { HostileFuzzer, type Counterexample, type ProbeResult } from "./fuzz.js";

/**
 * What the data claims, reduced to the two things the gate can attack: that
 * calling the member is clean, and that reading it is clean.
 */
export interface Claim {
  readonly cleanCall: boolean;
  readonly cleanGet: boolean;
  /**
   * Positions the clean call claim is conditioned on getting no argument. The
   * gate has to hold the claim to its own scope: an entry saying `new Map()`
   * is clean says nothing about `new Map(iterable)`, and probing the second
   * would refute a sentence nobody wrote.
   */
  readonly absent: ReadonlySet<number>;
}

export interface GateReport {
  readonly probed: readonly ProbeResult[];
  /** Clean claims the gate could not reach. Unprobed is not refuted. */
  readonly unprobed: readonly ProbeResult[];
  readonly counterexamples: readonly Counterexample[];
  /**
   * How often the gate reproduces a throw the data already admits. Reported,
   * never gated on: the gate's job is to fail, and a green run is only the
   * absence of a refutation.
   */
  readonly sensitivity: { readonly reproduced: number; readonly attempted: number };
  /**
   * The other half of that number: throwing entries the gate drove with every
   * conformant argument it could build and never made throw. The only signal
   * there is that an entry **over**-throws.
   *
   * Reported, never gated on, and the asymmetry with `counterexamples` is the
   * point: a throw the fuzzer cannot reproduce is evidence about the fuzzer's
   * reach as much as about the entry, and over-throwing costs precision rather
   * than soundness.
   */
  readonly unrefuted: readonly ProbeResult[];
}

/**
 * The `param<N>=nullish` conditions of an entry, as positions. Absence of the
 * whole field means maximally conditioned, which conditions nothing on being
 * absent — every callable parameter is conditioned on being *entered*.
 */
export function absentPositions(
  conditions: readonly string[] | undefined,
): ReadonlySet<number> {
  const positions = new Set<number>();
  for (const condition of conditions ?? []) {
    const parsed = parseConditionPath(condition);
    if (parsed?.requires === "nullish") positions.add(parsed.paramIndex);
  }
  return positions;
}

export function claimsOf(data: BaselineData): ReadonlyMap<string, Claim> {
  const claims = new Map<string, Claim>();
  for (const lib of Object.values(data.libs)) {
    for (const [key, entry] of Object.entries(lib)) {
      const accessor = entry.accessor;
      const claim: Claim = {
        cleanCall: entry.color === "non-throwing",
        cleanGet:
          accessor !== undefined &&
          accessor !== false &&
          accessor.get === "non-throwing",
        absent: absentPositions(entry.conditions),
      };
      const existing = claims.get(key);
      claims.set(
        key,
        existing === undefined
          ? claim
          : {
              cleanCall: existing.cleanCall || claim.cleanCall,
              cleanGet: existing.cleanGet || claim.cleanGet,
              // One member, several lib versions of its entry. The gate drives
              // what every one of them claims, so a position only one of them
              // conditions is still driven with a value for the others.
              absent: new Set(
                [...claim.absent].filter((at) => existing.absent.has(at)),
              ),
            },
      );
    }
  }
  return claims;
}

export function runFuzzGate(
  lib: LibProgram,
  members: readonly LibMember[],
  claims: ReadonlyMap<string, Claim>,
  throwingKeys: ReadonlySet<string> = new Set(),
): GateReport {
  const fuzzer = new HostileFuzzer(lib);
  const probed: ProbeResult[] = [];
  const unprobed: ProbeResult[] = [];
  const counterexamples: Counterexample[] = [];

  const record = (result: ProbeResult): void => {
    (result.probed ? probed : unprobed).push(result);
    counterexamples.push(...result.counterexamples);
  };

  for (const member of members) {
    const claim = claims.get(member.key);
    if (claim === undefined) continue;
    // Every clean *call* claim is probed, including one on a member with no
    // parameter list. Exempting those would let a claim ship that the gate
    // never looked at, which is the one thing unprobed-ships-floored exists to
    // prevent.
    if (claim.cleanCall) record(fuzzer.probeCall(member, claim.absent));
    if (claim.cleanGet) record(fuzzer.probeGet(member));
  }

  let reproduced = 0;
  let attempted = 0;
  const unrefuted: ProbeResult[] = [];
  for (const member of members) {
    if (!throwingKeys.has(member.key)) continue;
    const result = fuzzer.probeCall(member);
    if (!result.probed) continue;
    attempted++;
    if (result.counterexamples.length > 0) reproduced++;
    else unrefuted.push(result);
  }

  return {
    probed,
    unprobed,
    counterexamples,
    sensitivity: { reproduced, attempted },
    unrefuted,
  };
}

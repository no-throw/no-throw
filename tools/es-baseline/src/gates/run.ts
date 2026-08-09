import type { BaselineData, LibMember, LibProgram } from "@no-throw/core/baseline";

import { HostileFuzzer, type Counterexample, type ProbeResult } from "./fuzz.js";

/**
 * What the data claims, reduced to the two things the gate can attack: that
 * calling the member is clean, and that reading it is clean.
 */
export interface Claim {
  readonly cleanCall: boolean;
  readonly cleanGet: boolean;
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
      };
      const existing = claims.get(key);
      claims.set(
        key,
        existing === undefined
          ? claim
          : {
              cleanCall: existing.cleanCall || claim.cleanCall,
              cleanGet: existing.cleanGet || claim.cleanGet,
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
    if (claim.cleanCall) record(fuzzer.probeCall(member));
    if (claim.cleanGet) record(fuzzer.probeGet(member));
  }

  let reproduced = 0;
  let attempted = 0;
  for (const member of members) {
    if (!throwingKeys.has(member.key)) continue;
    const result = fuzzer.probeCall(member);
    if (!result.probed) continue;
    attempted++;
    if (result.counterexamples.length > 0) reproduced++;
  }

  return {
    probed,
    unprobed,
    counterexamples,
    sensitivity: { reproduced, attempted },
  };
}

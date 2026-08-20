import type { BaselineData, DomMember, LibProgram } from "@no-throw/core/baseline";

import { createDomEnvironment, type DomEnvironment } from "./environment.js";
import { HostileFuzzer, type Counterexample, type ProbeResult } from "./fuzz.js";

/**
 * What the data claims, reduced to the two things the gate can attack: that
 * calling the member is clean, and that reading it is clean. There is no write
 * probe — assigning to a shared receiver would corrupt every later probe — so
 * a clean `set` is never claimed in the first place.
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
   * absence of a refutation. #26 measured 0% with benign arguments and 100%
   * with the hostile pool, which is the whole difference between a gate and a
   * formality.
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
          accessor !== undefined && accessor !== false && accessor.get === "non-throwing",
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

export async function runFuzzGate(
  lib: LibProgram,
  members: readonly DomMember[],
  implementers: ReadonlyMap<string, readonly string[]>,
  claims: ReadonlyMap<string, Claim>,
  throwingKeys: ReadonlySet<string> = new Set(),
  environment: DomEnvironment = createDomEnvironment(),
): Promise<GateReport> {
  const fuzzer = new HostileFuzzer(lib, implementers, environment);
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

  const rejections = await fuzzer.settleRejections();
  // A rejection is only a counterexample to a claim the data actually makes.
  for (const rejection of rejections) {
    if (claims.get(rejection.key)?.cleanCall === true) counterexamples.push(rejection);
  }

  return { probed, unprobed, counterexamples, sensitivity: { reproduced, attempted } };
}

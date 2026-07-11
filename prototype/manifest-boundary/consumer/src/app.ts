// PROTOTYPE — the *consumer* package (no-throw ticket #15).
// @spike/mathkit is installed as a compiled dependency: dist/index.d.ts +
// dist/index.js + nothrow.json, NO source. Every color fact about it must
// arrive via the manifest — the JSDoc is stripped, the `async` keywords erased.

import { safeParse, parseStrict, fetchGreeting, fetchFlaky, badMark } from '@spike/mathkit';

// ── color across the boundary ──────────────────────────────────────────────

/** @nothrow */
export function handleConfig(raw: string): unknown {
  return safeParse(raw); // PASS: manifest says non-throwing
}

/** @nothrow */
export function handleStrict(raw: string): unknown {
  return parseStrict(raw); // FAIL: absent from manifest ⇒ throwing floor
}

/** @nothrow */
export function handleStrictBridged(raw: string): unknown {
  try {
    return parseStrict(raw); // PASS: floor-throwing, but bridged
  } catch {
    return null;
  }
}

// ── async flag across the boundary (#12) ───────────────────────────────────

/** @nothrow */
export async function greet(): Promise<string> {
  return await fetchGreeting('world'); // PASS: manifest non-throwing (full surface)
}

/** @nothrow */
export async function flakyAwaitBare(): Promise<string> {
  return await fetchFlaky(); // FAIL: manifest says throwing; await unbridged
}

/** @nothrow */
export async function flakyAwaitBridged(): Promise<string> {
  try {
    return await fetchFlaky(); // PASS: the universal bridge, try { await … } catch
  } catch {
    return 'fallback';
  }
}

/** @nothrow */
export function fireAndForget(): void {
  // PASS — but ONLY because the manifest carries async:true (sync-safe witness).
  // The .d.ts alone shows `(): Promise<string>`, which a rejecting-or-sync-
  // throwing function could also have. This is the load-bearing bit of #15.
  fetchFlaky().catch(() => {});
}

/** @nothrow */
export function fakeBridge(): void {
  try {
    fetchFlaky(); // FAIL: no await — try/catch bridges nothing here (#12 trap)
  } catch {
    /* never reached for the rejection */
  }
}

/** @nothrow */
export function floatEscape(): void {
  fetchFlaky(); // FAIL: statement-position float of a throwing async call (Tier 1)
}

// ── trust-by-construction across the boundary (#5) ─────────────────────────

/** @nothrow */
export function trustBadMark(): number {
  // FAIL: badMark is marked @nothrow in the producer SOURCE, but its mark is a
  // lie — the emit step refused it, so the manifest has no entry and the
  // consumer floors it to throwing. The unsound surface stays contained.
  return badMark();
}

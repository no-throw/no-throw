// PROTOTYPE — @spike/mathkit, the *producer* package (no-throw ticket #15).
// Colors are authored here as @nothrow JSDoc tags (#5). The build step
// (emit-manifest.mjs) verifies each mark and lowers the facts into nothrow.json;
// the compiled dist/ (.d.ts + .js, comments stripped) is what consumers see.

/** @nothrow */
export function safeParse(
  json: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(json) };
  } catch {
    return { ok: false, error: 'invalid json' };
  }
}

// Unmarked and sync-throwing: stays OUT of the manifest — consumers must floor
// it to throwing (absence = the sound default, #4).
export function parseStrict(json: string): unknown {
  return JSON.parse(json);
}

/** @nothrow */
export async function fetchGreeting(name: string): Promise<string> {
  return `hello ${name}`;
}

// Unmarked and rejecting — the `fetch` shape from #12: THROWING, but visibly
// async here, so it provably cannot throw synchronously. The .d.ts erases
// `async`; only the manifest's async flag can carry that witness across the
// boundary — and without it, consumers can never use the .catch bridge on this.
export async function fetchFlaky(): Promise<string> {
  throw new Error('flaky');
}

// A LYING mark: claims @nothrow but lets a throw escape. The emit step must
// refuse to lower it (trust-by-construction, #5), so across the boundary it
// falls back to the throwing floor — fail-safe, never unsound.
/** @nothrow */
export function badMark(): number {
  throw new Error('the mark was a lie');
}

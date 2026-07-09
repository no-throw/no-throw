// thirdparty.ts — CASE 4: a third-party throwing API (JSON.parse, declared in
// lib.es5.d.ts with no body → the engine's opaque floor = throwing).
// Bare → FLAGGED. Bridged → PASS.

/** @nothrow */
export function parseBare(text: string): unknown {
  return JSON.parse(text); // VIOLATION: unbridged third-party throwing call
}

/** @nothrow */
export function parseSafe(text: string): unknown {
  try {
    return JSON.parse(text); // bridged
  } catch {
    return null;
  }
}

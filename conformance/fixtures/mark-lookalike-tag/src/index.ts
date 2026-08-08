/** @nothrowx */
export function lookalike(): number {
  throw new Error("boom");
}

/** @nothrows */
export function pluralized(): number {
  throw new Error("boom");
}

/**
 * Unmarked; the `@nothrow` docs explain why.
 */
export function mentionsTheMark(): number {
  throw new Error("boom");
}

// TODO: mark this @nothrow once the callee is clean.
export function todo(): number {
  throw new Error("boom");
}

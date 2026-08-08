/** @NoThrow */
export function wrongCase(): number {
  throw new Error("boom");
}

/** @NOTHROW */
export function shouting(): number {
  throw new Error("boom");
}

/** @no-throw */
export function hyphenated(): number {
  throw new Error("boom");
}

/** @no_throw */
export function underscored(): number {
  throw new Error("boom");
}

/**
 * Parses the input.
 * @NoThrow
 */
export function afterProse(): number {
  throw new Error("boom");
}

/**
 * Baseline keys name a member the way the engine will meet it: by the
 * *declaring* interface and the member's own name. That is the one thing a
 * resolver can read off a symbol with no heuristics — `Array#push` from a
 * `push` declared in `interface Array<T>`, `ArrayConstructor#from` from the
 * constructor interface, `parseInt` from a top-level `declare function`.
 *
 * Well-known symbols spell as `@@name`, the same dialect the condition paths
 * use, so `[Symbol.iterator]` is `Array#@@iterator`.
 */

export function memberKey(owner: string, member: string): string {
  return `${owner}#${member}`;
}

/**
 * The static side, when there is no named interface to carry it. ES libs give
 * the constructor object its own interface (`ArrayConstructor`), so `#` covers
 * both sides there; `lib.dom.d.ts` writes it as an anonymous type literal on
 * `declare var Element`, leaving the variable's name as the only thing a
 * resolver can read. `.` separates it, which is the same JSDoc namepath
 * dialect the manifest keys use, and it keeps `Response.json` (static) apart
 * from `Response#json` (instance) — a collision `lib.dom.d.ts` really contains.
 */
export function staticMemberKey(owner: string, member: string): string {
  return `${owner}.${member}`;
}

/** `[Symbol.iterator]` → `@@iterator`; a plain name passes through. */
export function symbolMemberName(text: string): string {
  const match = /^\[\s*Symbol\.([A-Za-z_$][\w$]*)\s*\]$/.exec(text);
  return match?.[1] !== undefined ? `@@${match[1]}` : text;
}

/** `…/lib.es2015.core.d.ts` → `es2015.core`; anything else is not a lib file. */
export function libTargetOfFileName(fileName: string): string | undefined {
  return /(?:^|[\\/])lib\.([\w.]+)\.d\.ts$/.exec(fileName)?.[1];
}

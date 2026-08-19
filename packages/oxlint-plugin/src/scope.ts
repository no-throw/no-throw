/**
 * The files the rules reach, which is the same set the ESLint preset's
 * `files` glob names: TypeScript, `.d.ts` included. oxlint hands a JS plugin
 * every file it lints, and a type-aware rule loose on a `.js` file would
 * demand a program of trees that never promised one — so the scope the ESLint
 * host states in config, this host states here.
 */
export function isTypeScriptFile(fileName: string): boolean {
  return /\.(?:ts|tsx|mts|cts)$/.test(fileName);
}

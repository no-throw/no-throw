import globs from "globs";

/** @nothrow */
export function find(source: string): string[] {
  return globs.sync(source);
}

/** @nothrow */
export function escape(source: string): string {
  return globs.escapePath(source);
}

/** @nothrow */
export function escapePosix(source: string): string {
  return globs.posix.escapePath(source);
}

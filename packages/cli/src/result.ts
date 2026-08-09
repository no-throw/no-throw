import { relative, sep } from "node:path";

/** What the command has to say, and what it exits with. */
export interface CommandResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** Nothing could be analyzed: a bad invocation or project, not a bad package. */
export const CANNOT_RUN = 2;

/**
 * What was read cannot stand as it is: a mark that will not verify, a manifest
 * that has drifted, a carrier entry that colors nothing. Apart from
 * `CANNOT_RUN` so that a broken project cannot pass for a finished run with a
 * verdict.
 */
export const REFUSED = 1;

/**
 * A path as the reader will recognize it: relative to where they ran the
 * command, unless that reaches outside the working directory, where the
 * absolute path is the only one that means anything.
 */
export function display(cwd: string, path: string): string {
  const relativePath = relative(cwd, path).split(sep).join("/");
  return relativePath === "" || relativePath.startsWith("..")
    ? path
    : relativePath;
}

import {
  emitManifest,
  manifestDrift,
  OverridesError,
  type EmitSite,
  type ManifestDocument,
  type MarkRefusal,
} from "@no-throw/core";
import { readFileSync, writeFileSync } from "node:fs";
import { openProject } from "./project.js";
import { CANNOT_RUN, display, REFUSED, type CommandResult } from "./result.js";

export interface EmitOptions {
  /** Compare rather than write: the `prepublishOnly` shape. */
  readonly check: boolean;
  readonly project: string | undefined;
  readonly cwd: string;
}

/**
 * `nothrow emit`, and `nothrow emit --check`.
 *
 * The command builds a program, hands it to the engine, and writes down what
 * comes back. It resolves no colors and verifies no marks of its own — an
 * answer that differed from the one a consumer's ESLint gives would be a
 * second implementation of the guarantee.
 */
export function runEmit(options: EmitOptions): CommandResult {
  const opened = openProject(options.project, options.cwd);
  if (opened.kind === "error") {
    return { code: CANNOT_RUN, out: "", err: `nothrow: ${opened.message}\n` };
  }

  const { program, commandLine } = opened.project;

  // The package's own `nothrow.overrides.json` is read before any color is
  // resolved, and one this release cannot honor stops everything. That is a
  // broken project rather than an unpublishable package, so it exits as one
  // — and as a sentence, not a stack trace.
  let outcome;
  try {
    outcome = emitManifest(program, commandLine);
  } catch (error) {
    if (!(error instanceof OverridesError)) throw error;
    return { code: CANNOT_RUN, out: "", err: `nothrow: ${error.message}\n` };
  }

  // Nothing was read, so there is nothing to refuse: no `tsconfig.json`, no
  // build on disk, nowhere a manifest would be found. That is the same stop as
  // a project that would not open, and exits as one — a publishing script that
  // could not tell it from an unpublishable package would be reading a verdict
  // out of a run that never reached one.
  if (outcome.kind === "blocked") {
    return { code: CANNOT_RUN, out: "", err: `nothrow: ${outcome.message}\n` };
  }

  if (outcome.kind === "refused") {
    return {
      code: REFUSED,
      out: "",
      err: refusalReport(outcome.refusals, options),
    };
  }

  const path = display(options.cwd, outcome.path);

  if (!options.check) {
    writeFileSync(outcome.path, outcome.text);
    return {
      code: 0,
      out: `nothrow: wrote ${path}, ${summary(outcome.document)}.\n`,
      err: "",
    };
  }

  const drift = driftOf(outcome.path, outcome.document);
  if (drift !== undefined) {
    return {
      code: REFUSED,
      out: "",
      err:
        `nothrow: ${path} has drifted from this source: ${drift}. ` +
        "Run `nothrow emit` and commit the result.\n",
    };
  }

  return { code: 0, out: `nothrow: ${path} is up to date.\n`, err: "" };
}

/**
 * How the manifest on disk differs from the one this source produces. A file
 * that is missing or unreadable is drift like any other: what a consumer would
 * get is not what this source says.
 */
function driftOf(
  path: string,
  fresh: ManifestDocument,
): string | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return "there is no manifest there at all";
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return "it is not valid JSON";
  }

  return manifestDrift(parsed, fresh);
}

function summary(document: ManifestDocument): string {
  const symbols = Object.values(document.exports).reduce(
    (total, entries) => total + Object.keys(entries).length,
    0,
  );
  const files = Object.keys(document.files).length;
  return `${count(symbols, "verified mark")} over ${count(files, "file")}`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function refusalReport(
  refusals: readonly MarkRefusal[],
  options: EmitOptions,
): string {
  const lines = refusals.flatMap((refusal) => [
    `${place(options.cwd, refusal.at)}: ${refusal.message}`,
    ...refusal.sites.map((site) => `    ${place(options.cwd, site)}: ${site.what}`),
  ]);

  return [
    ...lines,
    "",
    `Nothing was written: ${count(refusals.length, "mark")} cannot be ` +
      "published as it stands.",
    "",
  ].join("\n");
}

function place(cwd: string, site: EmitSite): string {
  return `${display(cwd, site.fileName)}:${site.line}:${site.column}`;
}

import {
  emitManifest,
  manifestDrift,
  type EmitRefusal,
  type EmitSite,
  type ManifestDocument,
} from "@no-throw/core";
import { readFileSync, writeFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { openProject } from "./project.js";

export interface EmitOptions {
  /** Compare rather than write: the `prepublishOnly` shape. */
  readonly check: boolean;
  readonly project: string | undefined;
  readonly cwd: string;
}

/** What the command has to say, and what it exits with. */
export interface CommandResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** Nothing could be analyzed: a bad invocation or project, not a bad package. */
export const CANNOT_RUN = 2;
/** The package was read, and what it says cannot be published as it stands. */
const REFUSED = 1;

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
  const outcome = emitManifest(program, commandLine);

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
  refusals: readonly EmitRefusal[],
  options: EmitOptions,
): string {
  const lines = refusals.flatMap((refusal) => [
    refusal.at === undefined
      ? `nothrow: ${refusal.message}`
      : `${place(options.cwd, refusal.at)}: ${refusal.message}`,
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

function display(cwd: string, path: string): string {
  const relativePath = relative(cwd, path).split(sep).join("/");
  return relativePath === "" || relativePath.startsWith("..")
    ? path
    : relativePath;
}

import {
  checkCarriers,
  packageHomeOf,
  reachesNothing,
  type CheckedCarrier,
  type CheckedEntry,
} from "@no-throw/core";
import { openProject } from "./project.js";
import { CANNOT_RUN, display, REFUSED, type CommandResult } from "./result.js";

export interface CheckOptions {
  readonly project: string | undefined;
  readonly cwd: string;
}

/**
 * `nothrow check`.
 *
 * The command builds a program, hands it to the engine, and prints what comes
 * back. It holds no entry against anything of its own: which key a package
 * publishes is the same question the resolver answers, and a second answer to
 * it would be a second implementation of the guarantee.
 */
export function runCheck(options: CheckOptions): CommandResult {
  const opened = openProject(options.project, options.cwd);
  if (opened.kind === "error") {
    return { code: CANNOT_RUN, out: "", err: `nothrow: ${opened.message}\n` };
  }

  const { program, configPath } = opened.project;
  const { carriers } = checkCarriers(program, packageHomeOf(configPath));
  const entries = carriers.flatMap((carrier) => carrier.entries);
  const inert = entries.filter((entry) => entry.verdict === "unresolved");
  const fatal = carriers.some((carrier) => carrier.problem?.fatal === true);
  const tally: Tally = {
    checked: entries.length,
    // The two failures are counted apart because they are two faults with two
    // fixes: one is a key held against a surface, and the other never got as
    // far as a surface. Both fail the run — an entry that colors nothing does
    // it silently, which is the whole reason this command exists.
    dead: entries.filter(
      (entry) => reachesNothing(entry) && entry.verdict !== "unusable",
    ).length,
    unusable: entries.filter((entry) => entry.verdict === "unusable").length,
    absentPackages: inert.filter((entry) => entry.kind === "package").length,
    absentModules: inert.filter((entry) => entry.kind === "module").length,
  };

  const lines: string[] = [];
  for (const carrier of carriers) {
    const report = reportOn(carrier, options.cwd);
    if (report.length > 0) lines.push(...report, "");
  }
  lines.push(summary(tally, fatal));

  // Read off the same counts the summary is written from, so the exit code and
  // the last line cannot come to different verdicts: a failure the report does
  // not account for is a red build with nothing in it to act on.
  const text = `${lines.join("\n")}\n`;
  return tally.dead > 0 || tally.unusable > 0 || fatal
    ? { code: REFUSED, out: "", err: text }
    : { code: 0, out: text, err: "" };
}

/**
 * One carrier's section, or nothing where it has nothing to say. A file whose
 * every entry reaches is not worth a line: what the reader is looking for is
 * the one that does not.
 */
function reportOn(carrier: CheckedCarrier, cwd: string): readonly string[] {
  const problems = carrier.entries.filter(
    (entry) => entry.verdict !== "reaches",
  );
  if (carrier.problem === undefined && problems.length === 0) return [];

  const path = display(cwd, carrier.path);
  const lines = [path === carrier.name ? path : `${carrier.name} — ${path}`];
  if (carrier.problem !== undefined) lines.push(`  ${carrier.problem.message}`);
  for (const entry of problems) {
    lines.push(...entryLines(entry, carrier.schema, cwd));
  }
  return lines;
}

function entryLines(
  entry: CheckedEntry,
  schema: string,
  cwd: string,
): readonly string[] {
  const why = whyItReachesNothing(entry, schema, cwd);
  if (why.length === 0) return [];
  return [`  ${addressOf(entry)}`, ...why.map((line) => `    ${line}`)];
}

/**
 * The entry as its author wrote it. A module entry has two halves rather than
 * three, and reading its specifier as a subpath would print an address nobody
 * could find in the file.
 */
function addressOf(entry: CheckedEntry): string {
  return entry.kind === "package"
    ? `${entry.package} → ${JSON.stringify(entry.subpath)} → \`${entry.symbolPath}\``
    : `modules → ${JSON.stringify(entry.module)} → \`${entry.symbolPath}\``;
}

function whyItReachesNothing(
  entry: CheckedEntry,
  schema: string,
  cwd: string,
): readonly string[] {
  switch (entry.verdict) {
    case "reaches":
      return [];
    case "unresolved":
      return entry.kind === "module"
        ? [
            `nothing here declares the ambient module ${JSON.stringify(entry.module)}, so ` +
              "there is no surface to hold this against. Inert rather than wrong.",
          ]
        : [
            `nothing of \`${entry.package}\` is in this project, so there is ` +
              "no surface to hold this against. Inert rather than wrong.",
          ];
    case "declared-elsewhere":
      return [
        `${JSON.stringify(entry.module)} publishes this key, and what it reaches is ` +
          `declared in ${JSON.stringify(entry.declaredIn)} — which is the block a ` +
          "carrier is matched by, so this entry is never consulted.",
        `Key it under ${JSON.stringify(entry.declaredIn)} instead.`,
      ];
    case "not-ambient":
      return [
        `${JSON.stringify(entry.module)} publishes this key, and what it reaches is ` +
          "declared in no `declare module` block at all, so it has an export " +
          "surface address rather than a module one.",
        entry.shipsIn === undefined
          ? "Nothing names the package it ships in, so nothing keyed anywhere " +
            "reaches it until a `package.json` there names one."
          : `Key it under \`packages\` → \`${entry.shipsIn}\` instead.`,
      ];
    case "unusable":
      return [
        `this entry does not validate against \`${schema}\` at ` +
          `${entry.faults.map((fault) => `\`${fault}\``).join(", ")}, so the ` +
          "reader discarded it and it colors nothing.",
        // The one thing that separates this from an entry nobody wrote, and
        // the reason it is worth failing a run over: a carrier that claims a
        // key and cannot be honored floors it rather than handing it down.
        "Anything it would have colored floors rather than falling through " +
          "to the rung below.",
      ];
    case "no-subpath": {
      const nothingAt = `\`${entry.package}\` publishes nothing at ${JSON.stringify(entry.subpath)}`;
      // A package that publishes at no subpath at all has no list of subpaths
      // to offer instead, and a label with nothing after it reads as a bug in
      // the report rather than as the fact it is.
      return entry.subpaths.length === 0
        ? [
            `${nothingAt}, and nothing at any other subpath.`,
            "The walk from its entry points reached no name a carrier " +
              "could key, so no entry under this package reaches anything.",
          ]
        : [
            `${nothingAt}.`,
            `Its subpaths are: ${entry.subpaths.map((each) => JSON.stringify(each)).join(", ")}`,
          ];
    }
    case "no-key": {
      if (entry.kind === "module") {
        const publishes =
          `${JSON.stringify(entry.module)} declares no symbol at this key, ` +
          "so this entry colors nothing.";
        // A block that declares nothing a carrier could key has no list to
        // offer instead, and a label with nothing after it reads as a bug in
        // the report rather than as the fact it is.
        return entry.published.length === 0
          ? [
              publishes,
              "The walk over what it declares reached no name a carrier could " +
                "key, so no entry under this specifier reaches anything.",
            ]
          : [
              publishes,
              `What it declares: ${nearest(entry.published, entry.symbolPath)}`,
            ];
      }
      return [
        `\`${entry.package}\` publishes no symbol at this key, so this ` +
          "entry colors nothing.",
        `What it publishes at ${JSON.stringify(entry.subpath)}: ${nearest(entry.published, entry.symbolPath)}`,
      ];
    }
    case "ships-elsewhere":
      return [
        `\`${entry.package}\` publishes this key, and what it reaches ` +
          `ships in \`${entry.shipsIn}\` — which is the package a carrier is ` +
          "matched by, so this entry is never consulted.",
        `Key it under \`${entry.shipsIn}\` instead.`,
      ];
    case "unnamed-shipper":
      return [
        `\`${entry.package}\` publishes this key, and what it reaches is ` +
          `declared in ${display(cwd, entry.declaredIn)}, which names no package.`,
        "A carrier is matched by the npm name of the package a " +
          "declaration ships in, so nothing keyed under any name reaches it " +
          "until a `package.json` there names one.",
      ];
  }
}

/**
 * What a package publishes, cut off where a reader stops reading — a lodash-
 * shaped one has hundreds. The names ending in the same member the failed key
 * ended in come first, because that is what a near miss is: the right member,
 * reached by a path the package does not publish.
 */
function nearest(published: readonly string[], missed: string): string {
  const member = lastSegment(missed);
  const near = published.filter((each) => lastSegment(each) === member);
  const ordered = [...near, ...published.filter((each) => !near.includes(each))];

  const shown = ordered.slice(0, SHOWN).map((each) => `\`${each}\``);
  const rest = ordered.length - shown.length;
  return rest > 0 ? `${shown.join(", ")}, and ${rest} more` : shown.join(", ");
}

const SHOWN = 12;

/** The member a namepath ends in: `Class#member`, `Class.static`, `name`. */
function lastSegment(symbolPath: string): string {
  return symbolPath.split(/[#.]/u).at(-1) ?? symbolPath;
}

/** What the run came to, in the counts the last line is written out of. */
interface Tally {
  readonly checked: number;
  readonly dead: number;
  readonly unusable: number;
  /**
   * The two addresses are counted apart because they are inert for two
   * different reasons, and one clause covering both would tell a reader with
   * only module entries that they named a package they never wrote.
   */
  readonly absentPackages: number;
  readonly absentModules: number;
}

function summary(tally: Tally, fatal: boolean): string {
  const { checked, dead, unusable, absentPackages, absentModules } = tally;
  if (checked === 0) {
    return fatal
      ? "Nothing was checked: a carrier above is not being honored."
      : "No carrier entry to check.";
  }

  const clauses = [
    ...(dead === 0 ? [] : [`${count(dead, "reaches", "reach")} nothing`]),
    ...(unusable === 0
      ? []
      : [`${count(unusable, "does", "do")} not validate`]),
    ...(absentPackages === 0
      ? []
      : [
          `${count(absentPackages, "names", "name")} a package this project does not hold`,
        ]),
    ...(absentModules === 0
      ? []
      : [
          `${count(absentModules, "names", "name")} an ambient module nothing here declares`,
        ]),
  ];

  return clauses.length === 0
    ? `${count(checked, "entry", "entries")} checked, all reaching a published symbol.`
    : `${count(checked, "entry", "entries")} checked. ${clauses.join("; ")}.`;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

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

  const { program, commandLine } = opened.project;
  const configPath = commandLine.options.configFilePath;
  if (typeof configPath !== "string") {
    return {
      code: CANNOT_RUN,
      out: "",
      err:
        "nothrow: check needs the `tsconfig.json` a program was built from: " +
        "without it there is no project root to look for carriers beside.\n",
    };
  }

  const { carriers } = checkCarriers(program, packageHomeOf(configPath));
  const entries = carriers.flatMap((carrier) => carrier.entries);
  const dead = entries.filter(reachesNothing).length;
  const inert = entries.filter((entry) => entry.verdict === "unresolved").length;
  const fatal = carriers.some((carrier) => carrier.problem?.fatal === true);

  const lines: string[] = [];
  for (const carrier of carriers) {
    const report = reportOn(carrier, options.cwd);
    if (report.length > 0) lines.push(...report, "");
  }
  lines.push(summary(entries.length, dead, inert, fatal));

  const text = `${lines.join("\n")}\n`;
  return dead > 0 || fatal
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
  for (const entry of problems) lines.push(...entryLines(entry, cwd));
  return lines;
}

function entryLines(entry: CheckedEntry, cwd: string): readonly string[] {
  const at = `  ${entry.package} → ${JSON.stringify(entry.subpath)} → \`${entry.symbolPath}\``;

  switch (entry.verdict) {
    case "reaches":
      return [];
    case "unresolved":
      return [
        at,
        `    nothing of \`${entry.package}\` is in this project, so there is ` +
          "no surface to hold this against. Inert rather than wrong.",
      ];
    // A package that publishes at no subpath at all has no list of subpaths to
    // offer instead, and a label with nothing after it reads as a bug in the
    // report rather than as the fact it is.
    case "no-subpath":
      return entry.subpaths.length === 0
        ? [
            at,
            `    \`${entry.package}\` publishes nothing at ${JSON.stringify(entry.subpath)}, ` +
              "and nothing at any other subpath.",
            "    The walk from its entry points reached no name a carrier " +
              "could key, so no entry under this package reaches anything.",
          ]
        : [
            at,
            `    \`${entry.package}\` publishes nothing at ${JSON.stringify(entry.subpath)}.`,
            `    Its subpaths are: ${entry.subpaths.map((each) => JSON.stringify(each)).join(", ")}`,
          ];
    case "no-key":
      return [
        at,
        `    \`${entry.package}\` publishes no symbol at this key, so this ` +
          "entry colors nothing.",
        `    What it publishes at ${JSON.stringify(entry.subpath)}: ${nearest(entry.published, entry.symbolPath)}`,
      ];
    case "ships-elsewhere":
      return [
        at,
        `    \`${entry.package}\` publishes this key, and what it reaches ` +
          `ships in \`${entry.shipsIn}\` — which is the package a carrier is ` +
          "matched by, so this entry is never consulted.",
        `    Key it under \`${entry.shipsIn}\` instead.`,
      ];
    case "unnamed-shipper":
      return [
        at,
        `    \`${entry.package}\` publishes this key, and what it reaches is ` +
          `declared in ${display(cwd, entry.declaredIn)}, which names no package.`,
        "    A carrier is matched by the npm name of the package a " +
          "declaration ships in, so nothing keyed under any name reaches it " +
          "until that `package.json` names one.",
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

function summary(
  checked: number,
  dead: number,
  inert: number,
  fatal: boolean,
): string {
  if (checked === 0) {
    return fatal
      ? "Nothing was checked: a carrier above is not being honored."
      : "No carrier entry to check.";
  }

  const clauses = [
    ...(dead === 0 ? [] : [`${count(dead, "reaches", "reach")} nothing`]),
    ...(inert === 0
      ? []
      : [
          `${count(inert, "names", "name")} a package this project does not hold`,
        ]),
  ];

  return clauses.length === 0
    ? `${count(checked, "entry", "entries")} checked, all reaching a published symbol.`
    : `${count(checked, "entry", "entries")} checked. ${clauses.join("; ")}.`;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

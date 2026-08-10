import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  asRecord,
  readString,
  readStrings,
  readText,
  rejectUnknownKeys,
} from "./json.js";

/**
 * What a run of the binary has to do, as the exit code a script sees.
 * `refused` covers everything the tool read and will not stand behind — a mark
 * emit cannot verify, a manifest that has drifted, a carrier entry that colors
 * nothing; `cannot-run` is the different thing, and is asserted apart so that a
 * broken project cannot pass for one.
 */
export type Verdict = "ok" | "refused" | "cannot-run";

export const EXIT_CODES: Record<Verdict, number> = {
  ok: 0,
  refused: 1,
  "cannot-run": 2,
};

/** What every step that runs the binary states about the run. */
export interface Invocation {
  readonly args: readonly string[];
  readonly expect: Verdict;
  /** Text the output must contain — what the diagnostic has to name. */
  readonly names: readonly string[];
}

/**
 * One thing the case does to the producer, or asserts about it. Steps run in
 * order against one copy of the case, so a `--check` run can be asked about a
 * file the previous step changed.
 */
export type Step =
  /** Run `nothrow emit` in the producer, with `args` after the command. */
  | ({ readonly kind: "emit" } & Invocation)
  /**
   * Run `nothrow check` in a project of the case's own, rather than in the
   * producer: what it reads is what a *consumer* wrote and installed, so the
   * directory is named rather than assumed.
   */
  | ({ readonly kind: "check"; readonly directory: string } & Invocation)
  /**
   * Run the binary over the whole argv, command word or none. What the two
   * above cannot reach: an invocation the tool answers for out of its own
   * grammar rather than out of a project.
   */
  | ({ readonly kind: "run" } & Invocation)
  /** Assert facts about the emitted manifest, entry by entry. */
  | {
      readonly kind: "entries";
      readonly expected: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    }
  /** Assert a file the producer never got: emit writes nothing when it refuses. */
  | { readonly kind: "absent"; readonly file: string }
  /** A rebuild that changed no declaration: the same bytes, plus a comment. */
  | { readonly kind: "append"; readonly file: string; readonly text: string }
  /** A source change, spelled as the edit a developer would have made. */
  | {
      readonly kind: "replace";
      readonly file: string;
      readonly find: string;
      readonly with: string;
    }
  /**
   * Install the producer into a consumer project and run the consumer through
   * the fixture driver. This is what validates the wire format: the reader
   * that reads the emitted manifest is the one a user's ESLint runs.
   */
  | { readonly kind: "consumer"; readonly directory: string };

export interface CliCase {
  readonly name: string;
  readonly directory: string;
  readonly description: string;
  readonly steps: readonly Step[];
}

export function loadCliCases(root: string): CliCase[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => loadCase(root, name));
}

function loadCase(root: string, name: string): CliCase {
  const directory = join(root, name);
  const path = join(directory, "case.json");
  const raw = asRecord(JSON.parse(readFileSync(path, "utf8")), path);

  const steps = raw["steps"];
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`${path}: \`steps\` must be a non-empty array`);
  }

  return {
    name,
    directory,
    description: readString(raw, "description", path),
    steps: steps.map((step, index) =>
      readStep(step, `${path}: steps[${index}]`),
    ),
  };
}

/** What a step spelling an invocation may carry beyond the argv it keys on. */
const INVOCATION_KEYS = ["expect", "names"] as const;

const STEP_KEYS: Record<string, readonly string[]> = {
  emit: ["emit", ...INVOCATION_KEYS],
  check: ["check", "in", ...INVOCATION_KEYS],
  run: ["run", ...INVOCATION_KEYS],
  entries: ["entries"],
  absent: ["absent"],
  append: ["append", "text"],
  replace: ["replace", "find", "with"],
  consumer: ["consumer"],
};

function readStep(entry: unknown, where: string): Step {
  const record = asRecord(entry, where);
  const kinds = Object.keys(STEP_KEYS);
  const kind = kinds.find((key) => key in record);
  if (kind === undefined) {
    throw new Error(
      `${where}: no step here — expected one of ${kinds.join(", ")}`,
    );
  }
  rejectUnknownKeys(record, STEP_KEYS[kind] ?? [], where);

  switch (kind) {
    case "emit":
    case "run":
      return { kind, ...readInvocation(record, kind, where) };
    case "check":
      return {
        kind,
        ...readInvocation(record, kind, where),
        directory: readString(record, "in", where),
      };
    case "entries":
      return { kind, expected: readEntries(record["entries"], where) };
    case "absent":
      return { kind, file: readString(record, "absent", where) };
    case "append":
      return {
        kind,
        file: readString(record, "append", where),
        text: readString(record, "text", where),
      };
    case "replace":
      return {
        kind,
        file: readString(record, "replace", where),
        find: readString(record, "find", where),
        with: readText(record, "with", where),
      };
    default:
      return { kind: "consumer", directory: readString(record, "consumer", where) };
  }
}

/**
 * What the step left unsaid, as nothing asserted. A step that names nothing
 * the output has to say is a step about the exit code.
 */
function readOptionalStrings(
  record: Record<string, unknown>,
  key: string,
  where: string,
): readonly string[] {
  return key in record ? readStrings(record, key, where) : [];
}

function readEntries(
  value: unknown,
  where: string,
): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  const subpaths = asRecord(value, where);
  const read: Record<string, Record<string, unknown>> = {};
  for (const [subpath, entries] of Object.entries(subpaths)) {
    read[subpath] = asRecord(entries, `${where}: entries[${subpath}]`);
  }
  return read;
}

/** Every invocation step keys on its own kind, so that name is both. */
function readInvocation(
  record: Record<string, unknown>,
  kind: string,
  where: string,
): Invocation {
  return {
    args: readStrings(record, kind, where),
    expect: readVerdict(record, where),
    names: readOptionalStrings(record, "names", where),
  };
}

function readVerdict(record: Record<string, unknown>, where: string): Verdict {
  const value = record["expect"];
  if (typeof value !== "string" || !(value in EXIT_CODES)) {
    throw new Error(
      `${where}: \`expect\` must be one of ${Object.keys(EXIT_CODES).join(", ")}`,
    );
  }
  return value as Verdict;
}


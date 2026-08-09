import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Diagnostic, Suggestion } from "./diagnostics.js";
import { asRecord, readString, rejectUnknownKeys } from "./json.js";

/**
 * How the fixture is wired up: `rules` turns the rules on one by one, which is
 * what most fixtures want; `recommended` installs the shipped preset, so a
 * fixture can assert what a user gets from the config they actually install;
 * `recommended-beside-typescript-eslint` puts the preset into a config that has
 * already registered `@typescript-eslint`, which is what the audience the
 * preset is for actually has.
 */
export type FixtureConfig =
  | "rules"
  | "recommended"
  | "recommended-beside-typescript-eslint";

const CONFIGS: readonly FixtureConfig[] = [
  "rules",
  "recommended",
  "recommended-beside-typescript-eslint",
];

export interface Fixture {
  readonly name: string;
  readonly directory: string;
  readonly description: string;
  readonly config: FixtureConfig;
  readonly expected: readonly Diagnostic[];
}

export function loadFixtures(fixturesRoot: string): Fixture[] {
  return readdirSync(fixturesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => loadFixture(join(fixturesRoot, name)));
}

/**
 * One fixture project, wherever it sits. The CLI suite consumes a manifest a
 * process just emitted, and what makes that the wire format's test rather than
 * a snapshot is that the reader reading it is this one.
 */
export function loadFixture(directory: string): Fixture {
  const name = basename(directory);
  const path = join(directory, "expected.json");
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const root = asRecord(raw, path);

  const diagnostics = root["diagnostics"];
  if (!Array.isArray(diagnostics)) {
    throw new Error(`${path}: \`diagnostics\` must be an array`);
  }

  return {
    name,
    directory,
    description: readString(root, "description", path),
    config: readConfig(root, path),
    expected: diagnostics.map((entry, index) =>
      readDiagnostic(entry, `${path}: diagnostics[${index}]`),
    ),
  };
}

function readConfig(
  root: Record<string, unknown>,
  path: string,
): FixtureConfig {
  const value = root["config"];
  if (value === undefined) return "rules";
  if (!CONFIGS.includes(value as FixtureConfig)) {
    throw new Error(
      `${path}: \`config\` must be one of ${CONFIGS.map((name) => `"${name}"`).join(", ")}`,
    );
  }
  return value as FixtureConfig;
}

const POSITION_KEYS = ["line", "column", "endLine", "endColumn"] as const;
const DIAGNOSTIC_KEYS = [
  "file",
  ...POSITION_KEYS,
  "messageId",
  "message",
  "suggestions",
];
const SUGGESTION_KEYS = ["desc", "output"];

function readDiagnostic(entry: unknown, where: string): Diagnostic {
  const record = asRecord(entry, where);
  rejectUnknownKeys(record, DIAGNOSTIC_KEYS, where);

  const message = record["message"];
  if (message !== undefined && typeof message !== "string") {
    throw new Error(`${where}: \`message\`, when present, must be a string`);
  }

  const suggestions = record["suggestions"];
  if (suggestions !== undefined && !Array.isArray(suggestions)) {
    throw new Error(
      `${where}: \`suggestions\`, when present, must be an array — an ` +
        "empty one asserts the diagnostic offers no edit",
    );
  }

  return {
    file: readString(record, "file", where),
    line: readPosition(record, "line", where),
    column: readPosition(record, "column", where),
    endLine: readPosition(record, "endLine", where),
    endColumn: readPosition(record, "endColumn", where),
    messageId: readString(record, "messageId", where),
    ...(message === undefined ? {} : { message }),
    ...(suggestions === undefined
      ? {}
      : {
          suggestions: suggestions.map((suggestion, index) =>
            readSuggestion(suggestion, `${where}: suggestions[${index}]`),
          ),
        }),
  };
}

function readSuggestion(entry: unknown, where: string): Suggestion {
  const record = asRecord(entry, where);
  rejectUnknownKeys(record, SUGGESTION_KEYS, where);

  const output = record["output"];
  if (
    !Array.isArray(output) ||
    output.some((line) => typeof line !== "string")
  ) {
    throw new Error(
      `${where}: \`output\` must be the file the edit produces, one array ` +
        "entry per line",
    );
  }

  return { desc: readString(record, "desc", where), output: output as string[] };
}

function readPosition(
  record: Record<string, unknown>,
  key: string,
  where: string,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${where}: \`${key}\` must be a positive integer`);
  }
  return value;
}

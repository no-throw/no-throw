import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Diagnostic } from "./diagnostics.js";

/**
 * How the fixture is wired up: `rules` turns the rules on one by one, which is
 * what most fixtures want; `recommended` installs the shipped preset, so a
 * fixture can assert what a user gets from the config they actually install.
 */
export type FixtureConfig = "rules" | "recommended";

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
    .map((name) => loadFixture(fixturesRoot, name));
}

function loadFixture(fixturesRoot: string, name: string): Fixture {
  const directory = join(fixturesRoot, name);
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
  if (value !== "rules" && value !== "recommended") {
    throw new Error(`${path}: \`config\` must be "rules" or "recommended"`);
  }
  return value;
}

const POSITION_KEYS = ["line", "column", "endLine", "endColumn"] as const;
const KNOWN_KEYS = new Set<string>([
  "file",
  ...POSITION_KEYS,
  "messageId",
  "message",
]);

function readDiagnostic(entry: unknown, where: string): Diagnostic {
  const record = asRecord(entry, where);

  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.has(key)) throw new Error(`${where}: unknown key \`${key}\``);
  }

  const message = record["message"];
  if (message !== undefined && typeof message !== "string") {
    throw new Error(`${where}: \`message\`, when present, must be a string`);
  }

  return {
    file: readString(record, "file", where),
    line: readPosition(record, "line", where),
    column: readPosition(record, "column", where),
    endLine: readPosition(record, "endLine", where),
    endColumn: readPosition(record, "endColumn", where),
    messageId: readString(record, "messageId", where),
    ...(message === undefined ? {} : { message }),
  };
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where}: expected a JSON object`);
  }
  return value as Record<string, unknown>;
}

function readString(
  record: Record<string, unknown>,
  key: string,
  where: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`${where}: \`${key}\` must be a non-empty string`);
  }
  return value;
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

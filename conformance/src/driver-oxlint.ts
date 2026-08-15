import { noEscapingThrow, validMark } from "@no-throw/oxlint-plugin";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Diagnostic } from "./diagnostics.js";

/**
 * The oxlint driver: run a fixture project through the real binary, the way a
 * user runs `oxlint .` from their project root, and hand back what it
 * reported. It knows nothing about the engine — only what a consumer's oxlint
 * would print.
 *
 * Two things the ESLint driver observes have no channel here, and the runner
 * accounts for both rather than letting them pass silently. oxlint's JSON
 * carries no messageId — it is recovered by matching the message against the
 * plugin's own catalog — and no suggestions, so the offer's *content* is
 * asserted by the ESLint pass over the same fixtures and the offer's
 * *plumbing* by the runner's fixer probes.
 */

const execFileAsync = promisify(execFile);

const require = createRequire(import.meta.url);

/** The binary the conformance package resolves, run through this Node. */
const OXLINT_BIN = join(
  require.resolve("oxlint/package.json"),
  "..",
  "bin",
  "oxlint",
);

const CONFIG = fileURLToPath(new URL("../oxlint.config.json", import.meta.url));

export interface OxlintRun {
  readonly exitCode: number;
  /** Ours, mapped into the suite's currency. */
  readonly diagnostics: readonly Diagnostic[];
  /** `Error running JS plugin` reports — a rule of ours died on a file. */
  readonly pluginErrors: readonly string[];
  /** Anything else would mean the run was not the one this driver claims. */
  readonly foreign: readonly string[];
}

export async function runFixtureOxlint(directory: string): Promise<OxlintRun> {
  const { stdout, exitCode } = await run(
    ["-c", CONFIG, "-f", "json", "."],
    directory,
  );

  const parsed = JSON.parse(stdout) as {
    readonly diagnostics: readonly RawDiagnostic[];
  };

  const diagnostics: Diagnostic[] = [];
  const pluginErrors: string[] = [];
  const foreign: string[] = [];

  for (const raw of parsed.diagnostics) {
    if (raw.code?.startsWith("nothrow(") === true) {
      diagnostics.push(toDiagnostic(raw, directory));
    } else if (raw.message.startsWith("Error running JS plugin.")) {
      pluginErrors.push(raw.message);
    } else {
      foreign.push(`${raw.code ?? "?"}: ${raw.message}`);
    }
  }

  return { exitCode, diagnostics, pluginErrors, foreign };
}

/** `--fix`, then `--fix-suggestions`, for the runner's fixer probes. */
export async function runOxlintFix(
  directory: string,
  flag: "--fix" | "--fix-suggestions",
): Promise<void> {
  await run(["-c", CONFIG, flag, "."], directory);
}

async function run(
  args: readonly string[],
  cwd: string,
): Promise<{ stdout: string; exitCode: number }> {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [OXLINT_BIN, ...args],
      { cwd, maxBuffer: 64 * 1024 * 1024 },
    );
    return { stdout, exitCode: 0 };
  } catch (error) {
    // Diagnostics found is exit 1 and still a run; anything without stdout is
    // the binary itself failing, which no fixture asserts.
    const failed = error as { stdout?: string; code?: number };
    if (typeof failed.stdout !== "string" || failed.stdout === "") throw error;
    return { stdout: failed.stdout, exitCode: failed.code ?? 1 };
  }
}

interface RawDiagnostic {
  readonly message: string;
  readonly code?: string;
  readonly severity: string;
  readonly filename: string;
  readonly labels: readonly {
    readonly span: { readonly offset: number; readonly length: number };
  }[];
}

function toDiagnostic(raw: RawDiagnostic, directory: string): Diagnostic {
  const span = raw.labels[0]?.span;
  if (span === undefined) {
    throw new Error(`${raw.filename}: a nothrow diagnostic carried no span`);
  }

  // oxlint spans are UTF-8 byte offsets; the suite's currency is the character
  // positions ESLint reports. The file is the ruler both are read against.
  const buffer = readFileSync(join(directory, raw.filename));
  const start = positionAt(buffer, span.offset);
  const end = positionAt(buffer, span.offset + span.length);

  return {
    file: raw.filename.replace(/\\/g, "/"),
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
    messageId: messageIdOf(raw.message),
    message: raw.message,
  };
}

/** 1-based line and column, the way the ESLint driver hands them over. */
function positionAt(
  buffer: Buffer,
  byteOffset: number,
): { line: number; column: number } {
  const bom = buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
    ? 3
    : 0;
  const before = buffer.subarray(bom, bom + byteOffset).toString("utf8");
  const lastBreak = before.lastIndexOf("\n");
  const line = (before.match(/\n/g)?.length ?? 0) + 1;
  return { line, column: before.length - lastBreak };
}

/**
 * The messageId, recovered from the text. oxlint's JSON does not carry one, so
 * the driver matches the message against the same catalog the plugin reports
 * from — every template becomes a pattern, and where more than one matches,
 * the one with the most literal text wins: a specific message always embeds
 * more of itself than the general one it also happens to satisfy.
 */
const catalog: readonly { id: string; pattern: RegExp; literal: number }[] =
  Object.entries(mergedCatalog()).map(([id, template]) => ({
    id,
    pattern: new RegExp(
      `^${template
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\\\{\\\{\w+\\\}\\\}/g, "[\\s\\S]+?")}$`,
    ),
    literal: template.replace(/\{\{\w+\}\}/g, "").length,
  }));

/** One id in both rules would let a spread drop a template unnoticed. */
function mergedCatalog(): Record<string, string> {
  const escape = noEscapingThrow.meta.messages;
  const mark = validMark.meta.messages;
  for (const id of Object.keys(mark)) {
    if (id in escape) {
      throw new Error(`both rules define the messageId \`${id}\``);
    }
  }
  return { ...escape, ...mark };
}

function messageIdOf(message: string): string {
  const matches = catalog
    .filter((entry) => entry.pattern.test(message))
    .sort((a, b) => b.literal - a.literal);
  const best = matches[0];
  if (best === undefined) {
    throw new Error(`no catalog message matches: ${message}`);
  }
  return best.id;
}

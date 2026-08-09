import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** How the child hands its result back through a stream ESLint also writes. */
export const RESULT_MARKER = "##dogfood##";

export interface LintResult {
  readonly wallMs: number;
  readonly files: number;
  readonly errors: number;
  readonly warnings: number;
  /** Diagnostics per rule, so an arm's report volume is on the record. */
  readonly counts: Readonly<Record<string, number>>;
}

export interface ColdRun extends LintResult {
  /** Process wall time, which is what CI pays: startup, program build and all. */
  readonly processMs: number;
  /** ESLint's own per-rule accounting, in milliseconds. */
  readonly ruleMs: Readonly<Record<string, number>>;
}

const CHILD = fileURLToPath(new URL("./bin/lint-once.js", import.meta.url));

/**
 * A cold arm: a fresh process, a fresh program, nothing warm. `TIMING` is set
 * high enough that every rule is reported — the default keeps ten, and the
 * whole point is our rule's share against everything else's.
 */
export async function coldLint(options: {
  readonly targetDirectory: string;
  readonly configFile: string;
  readonly paths: readonly string[];
  readonly ignore: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}): Promise<ColdRun> {
  const started = performance.now();
  const child = spawn(
    process.execPath,
    [
      "--max-old-space-size=8192",
      CHILD,
      options.targetDirectory,
      options.configFile,
      options.paths.join(","),
      options.ignore.join(","),
    ],
    {
      env: { ...process.env, TIMING: "1000", ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));

  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve(status ?? -1));
  });
  const processMs = performance.now() - started;

  const marked = stdout
    .split("\n")
    .find((line) => line.startsWith(RESULT_MARKER));
  if (code !== 0 || marked === undefined) {
    throw new Error(
      `lint-once exited ${String(code)}\n${stdout.slice(-4000)}\n${stderr.slice(-4000)}`,
    );
  }

  return {
    ...(JSON.parse(marked.slice(RESULT_MARKER.length)) as LintResult),
    processMs,
    ruleMs: parseTiming(stdout),
  };
}

/**
 * ESLint prints its timing table on exit, after the result line. Reading it
 * rather than wrapping the rule ourselves keeps the harness out of the number:
 * the accounting is the host's, and it is the same accounting a user sees from
 * `TIMING=1 eslint`.
 */
function parseTiming(stdout: string): Record<string, number> {
  const times: Record<string, number> = {};
  for (const line of stdout.split("\n")) {
    const match = /^(\S+)\s*\|\s*([\d.]+)\s*\|/.exec(line.trim());
    if (match?.[1] === undefined || match[2] === undefined) continue;
    if (match[1] === "Rule") continue;
    times[match[1]] = Number(match[2]);
  }
  return times;
}

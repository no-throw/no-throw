/**
 * What one project costs end to end on each backend — #81's "price a realistic
 * project, not a synthetic one".
 *
 * The two numbers that matter are separated, because they answer different
 * questions: **build** is what it takes to have a checked program at all, and
 * **analysis** is what `no-throw` adds on top. #10 chose in-process on the
 * second being small against the first; whether that still holds when the
 * checker is out of process is the whole question.
 *
 * Usage: node wall-clock.mjs <project-root> [more-roots...]
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);

function run(backend, root, runs) {
  const args = backend === "ts7" ? ["--import", "./tsgo/register.mjs"] : [];
  const child = spawnSync(
    process.execPath,
    [...args, HERE, "--child", backend, root, String(runs)],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (child.status !== 0) {
    return { failed: (child.stderr || child.stdout).split("\n")[0] };
  }
  return JSON.parse(child.stdout);
}

const argv = process.argv.slice(2);

if (argv[0] === "--child") {
  const [, backend, root, runs] = argv;
  const { analyzeOne } = await (backend === "ts7"
    ? import("./tsgo/backend-ts7.mjs")
    : import("./tsgo/backend-ts6.mjs"));

  const builds = [];
  const analyses = [];
  let files = 0;
  let findings = 0;
  for (let i = 0; i < Number(runs); i++) {
    const result = analyzeOne(path.resolve(root));
    builds.push(result.buildMs);
    analyses.push(result.analyzeMs);
    files = Object.keys(result.reports).length;
    findings = Object.values(result.reports).flat().length;
  }
  const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
  process.stdout.write(
    JSON.stringify({
      buildMs: median(builds),
      analyzeMs: median(analyses),
      files,
      findings,
    }),
  );
} else {
  const runs = 3;
  const header = [
    "project".padEnd(34),
    "backend".padEnd(8),
    "files".padStart(6),
    "findings".padStart(9),
    "build".padStart(10),
    "analysis".padStart(10),
    "total".padStart(10),
  ].join(" ");
  console.log(`median of ${runs} runs\n`);
  console.log(header);
  console.log("-".repeat(header.length));

  for (const root of argv) {
    for (const backend of ["ts6", "ts7"]) {
      const r = run(backend, root, runs);
      if (r.failed !== undefined) {
        console.log(
          `${path.basename(root).padEnd(34)} ${backend.padEnd(8)} failed: ${r.failed.slice(0, 70)}`,
        );
        continue;
      }
      console.log(
        [
          path.basename(root).padEnd(34),
          backend.padEnd(8),
          String(r.files).padStart(6),
          String(r.findings).padStart(9),
          `${r.buildMs.toFixed(0)} ms`.padStart(10),
          `${r.analyzeMs.toFixed(0)} ms`.padStart(10),
          `${(r.buildMs + r.analyzeMs).toFixed(0)} ms`.padStart(10),
        ].join(" "),
      );
    }
  }
}

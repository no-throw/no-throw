/**
 * The same engine, driven by a TypeScript 7 client: `TypeFacts` over the tsgo
 * checker, and the syntax layer resolved to the shim by the loader.
 */
import { analyzeSourceFile } from "@nothrow/core";
import { API } from "@typescript/native-preview/unstable/sync";
import path from "node:path";
import { tsgoFacts } from "./facts.mjs";
import { report, sourcesIn } from "./sources.mjs";

const slash = (p) => p.split(path.sep).join("/");

/**
 * The engine takes a `ts.Program` for one reason: the export-surface walk reads
 * a package's entry-point *files*, which are files rather than types. A tsgo
 * run has no such object — and after #81 made the export key lazy, nothing
 * reaches for one unless a carrier rung has a table to look a key up in. This
 * stands in and says so loudly if that stops holding.
 */
function programStandIn() {
  const refuse = (name) => () => {
    throw new Error(`the TypeScript 7 run reached ts.Program.${name}`);
  };
  return {
    getSourceFiles: refuse("getSourceFiles"),
    getTypeChecker: refuse("getTypeChecker"),
    isSourceFileFromExternalLibrary: refuse("isSourceFileFromExternalLibrary"),
  };
}

export function analyzeOne(root) {
  const configPath = slash(path.join(root, "tsconfig.json"));
  const api = new API({ cwd: root });
  try {
    const buildStart = performance.now();
    const snapshot = api.updateSnapshot({ openProjects: [configPath] });
    const project =
      snapshot.getProject(configPath) ?? snapshot.getProjects()[0];
    if (project === undefined) throw new Error(`no project at ${configPath}`);
    const buildMs = performance.now() - buildStart;

    const gaps = new Set();
    const facts = tsgoFacts(project.checker, gaps);
    const program = programStandIn();
    const own = sourcesIn(root);
    const reports = {};

    const analyzeStart = performance.now();
    for (const name of project.program.getSourceFileNames()) {
      if (!own.has(path.resolve(name))) continue;
      const sourceFile = project.program.getSourceFile(slash(name));
      if (sourceFile === undefined) continue;
      reports[path.relative(root, name).split(path.sep).join("/")] = report(
        analyzeSourceFile(sourceFile, program, facts),
      );
    }

    return {
      reports,
      gaps: [...gaps],
      buildMs,
      analyzeMs: performance.now() - analyzeStart,
    };
  } finally {
    api.close();
  }
}

/** The shipped configuration: the engine on the host's own `ts.TypeChecker`. */
import { analyzeSourceFile } from "@nothrow/core";
import path from "node:path";
import ts from "typescript";
import { report, sourcesIn } from "./sources.mjs";

export function analyzeOne(root) {
  const configPath = path.join(root, "tsconfig.json");
  const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(
        ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
      );
    },
  });
  if (config === undefined) throw new Error(`could not read ${configPath}`);

  const buildStart = performance.now();
  const program = ts.createProgram(config.fileNames, config.options);
  program.getTypeChecker();
  const buildMs = performance.now() - buildStart;

  const own = sourcesIn(root);
  const reports = {};

  const analyzeStart = performance.now();
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile) continue;
    if (!own.has(path.resolve(file.fileName))) continue;
    reports[path.relative(root, file.fileName).split(path.sep).join("/")] =
      report(analyzeSourceFile(file, program));
  }
  const analyzeMs = performance.now() - analyzeStart;

  return { reports, buildMs, analyzeMs };
}

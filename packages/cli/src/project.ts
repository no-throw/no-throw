import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";

/**
 * A program the CLI built, with the configuration it was built from. Both,
 * because a package's published surface is named in `package.json` as built
 * files, and only the compiler's own configuration says which source produced
 * one.
 */
export interface Project {
  readonly program: ts.Program;
  readonly commandLine: ts.ParsedCommandLine;
}

export type OpenedProject =
  | { readonly kind: "project"; readonly project: Project }
  | { readonly kind: "error"; readonly message: string };

/**
 * Build the program the engine will read. This is the whole of what the CLI
 * adds over the ESLint adapter: the adapter reuses the program its host owns,
 * and here there is no host, so one is built the way `tsc` would.
 */
export function openProject(
  projectArgument: string | undefined,
  cwd: string,
): OpenedProject {
  const configPath = configPathOf(projectArgument ?? ".", cwd);
  if (configPath === undefined) {
    return {
      kind: "error",
      message:
        `no \`tsconfig.json\` at \`${projectArgument ?? cwd}\`. ` +
        "Name one with `--project`.",
    };
  }

  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error !== undefined) {
    return { kind: "error", message: format([read.error]) };
  }

  const commandLine = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
  );
  if (commandLine.errors.length > 0) {
    return { kind: "error", message: format(commandLine.errors) };
  }

  const program = ts.createProgram({
    rootNames: commandLine.fileNames,
    options: commandLine.options,
    ...(commandLine.projectReferences === undefined
      ? {}
      : { projectReferences: commandLine.projectReferences }),
  });

  return { kind: "project", project: { program, commandLine } };
}

function configPathOf(argument: string, cwd: string): string | undefined {
  const path = resolve(cwd, argument);
  if (!existsSync(path)) return undefined;
  const candidate = statSync(path).isDirectory()
    ? resolve(path, "tsconfig.json")
    : path;
  return existsSync(candidate) ? candidate : undefined;
}

function format(diagnostics: readonly ts.Diagnostic[]): string {
  return ts
    .formatDiagnostics(diagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getNewLine: () => "\n",
    })
    .trimEnd();
}

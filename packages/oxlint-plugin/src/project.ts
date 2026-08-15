import { dirname } from "node:path";
import ts from "typescript";

/**
 * The ESLint host hands the rules a program its parser already built; oxlint
 * hands a plugin no type information at all, so this is the one thing the
 * adapter has to do itself: find the `tsconfig.json` above each file, build a
 * program from it, and keep it for the files that follow. Hosting, not
 * analysis — the same job `projectService` does on the other side, with the
 * same answer for a file no project includes.
 */

export type ProjectAnswer =
  | {
      readonly kind: "program";
      readonly program: ts.Program;
      readonly sourceFile: ts.SourceFile;
    }
  /** No `tsconfig.json` anywhere above the file. */
  | { readonly kind: "no-project" }
  /** A config was found and read, and its file set leaves this file out. */
  | { readonly kind: "outside-project"; readonly configPath: string }
  /** A config was found and could not be read as a project. */
  | {
      readonly kind: "broken-project";
      readonly configPath: string;
      readonly message: string;
    };

interface Project {
  program: ts.Program;
  /**
   * Text the host holds that disk does not — an editor buffer mid-edit. Keyed
   * the way the compiler keys files, so a rebuilt program reads the buffer
   * wherever it would have read the file.
   */
  readonly overrides: Map<string, string>;
}

/**
 * One project per `tsconfig.json`, for the life of the process. A CLI run is a
 * fresh process, so CI — where the guarantee lives — never sees a stale
 * program; a long-lived host re-reads a file only when the text it hands over
 * stops matching, which is the editor-feedback tier of freshness.
 */
const projects = new Map<string, Project>();

export function projectFor(fileName: string, text: string): ProjectAnswer {
  const configPath = ts.findConfigFile(dirname(fileName), ts.sys.fileExists);
  if (configPath === undefined) return { kind: "no-project" };

  let project = projects.get(configPath);
  if (project === undefined) {
    const built = build(configPath, new Map());
    if (typeof built === "string") {
      return { kind: "broken-project", configPath, message: built };
    }
    project = { program: built, overrides: new Map() };
    projects.set(configPath, project);
  }

  let sourceFile = project.program.getSourceFile(fileName);
  if (sourceFile !== undefined && sourceFile.text !== text) {
    project.overrides.set(keyOf(fileName), text);
    const rebuilt = build(configPath, project.overrides);
    if (typeof rebuilt === "string") {
      return { kind: "broken-project", configPath, message: rebuilt };
    }
    project.program = rebuilt;
    sourceFile = project.program.getSourceFile(fileName);
  }

  if (sourceFile === undefined) return { kind: "outside-project", configPath };
  return { kind: "program", program: project.program, sourceFile };
}

function build(
  configPath: string,
  overrides: ReadonlyMap<string, string>,
): ts.Program | string {
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error !== undefined) return format([read.error]);

  const commandLine = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
  );
  if (commandLine.errors.length > 0) return format(commandLine.errors);

  const host = ts.createCompilerHost(commandLine.options, true);
  if (overrides.size > 0) {
    const readFile = host.readFile.bind(host);
    host.readFile = (file) => overrides.get(keyOf(file)) ?? readFile(file);
  }

  return ts.createProgram({
    rootNames: commandLine.fileNames,
    options: commandLine.options,
    host,
    ...(commandLine.projectReferences === undefined
      ? {}
      : { projectReferences: commandLine.projectReferences }),
  });
}

/** The compiler's own file identity: slashes normalized, case where it is data. */
function keyOf(fileName: string): string {
  const slashed = fileName.replace(/\\/g, "/");
  return ts.sys.useCaseSensitiveFileNames ? slashed : slashed.toLowerCase();
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

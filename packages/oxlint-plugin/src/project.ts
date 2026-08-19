import { dirname } from "node:path";
import ts from "typescript";

/**
 * The ESLint host hands the rules a program its parser already built; oxlint
 * hands a plugin no type information at all, so this is the one thing the
 * adapter has to do itself: find the `tsconfig.json` that holds each file,
 * build a program from it, and keep it for the files that follow. Hosting,
 * not analysis — the same job `projectService` does on the other side, with
 * the same answer for a file no project includes.
 */

export type ProjectAnswer =
  | {
      readonly kind: "program";
      readonly program: ts.Program;
      readonly sourceFile: ts.SourceFile;
    }
  /** No `tsconfig.json` anywhere above the file. */
  | { readonly kind: "no-project" }
  /** Configs were found and read, and every file set leaves this file out. */
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
  /**
   * Files a rebuild already failed to find, so a tree of files nothing
   * includes costs one rebuild each rather than one per lint of each.
   */
  readonly outside: Set<string>;
}

/**
 * One project per `tsconfig.json`, for the life of the process. A CLI run is a
 * fresh process, so CI — where the guarantee lives — never sees a stale
 * program; a long-lived host re-reads a file when the text it hands over
 * stops matching, and re-globs a config when a file it has never seen asks,
 * which is the editor-feedback tier of freshness.
 */
const projects = new Map<string, Project>();

export function projectFor(fileName: string, text: string): ProjectAnswer {
  // The nearest config is asked first, and on a miss the walk continues to
  // the configs above it — a monorepo file held by a root config rather than
  // the leaf one beside it is that config's file, not an orphan. What this
  // does not follow is a solution-style config's `references`; a layout only
  // they can express reports `outside-project` naming the nearest config.
  let searched = dirname(fileName);
  let nearest: string | undefined;
  let previous: string | undefined;

  for (;;) {
    const configPath = ts.findConfigFile(searched, ts.sys.fileExists);
    // Repetition is the root: a config whose directory has no parent comes
    // back from the same search forever.
    if (configPath === undefined || configPath === previous) {
      return nearest === undefined
        ? { kind: "no-project" }
        : { kind: "outside-project", configPath: nearest };
    }
    previous = configPath;
    nearest ??= configPath;

    const answer = fromProject(configPath, fileName, text);
    if (answer !== undefined) return answer;

    searched = dirname(dirname(configPath));
  }
}

/** This config's answer for the file, or nothing if it does not hold it. */
function fromProject(
  configPath: string,
  fileName: string,
  text: string,
): ProjectAnswer | undefined {
  let project = projects.get(configPath);
  if (project === undefined) {
    const built = build(configPath, new Map());
    if (typeof built === "string") {
      return { kind: "broken-project", configPath, message: built };
    }
    project = { program: built, overrides: new Map(), outside: new Set() };
    projects.set(configPath, project);
  }

  const key = keyOf(fileName);
  let sourceFile = project.program.getSourceFile(fileName);

  // A file the program has never seen may have been created since the program
  // was built, so the verdict is only settled by one fresh look — after
  // which a repeat of the same miss is answered from memory.
  if (sourceFile === undefined && !project.outside.has(key)) {
    const rebuilt = rebuild(configPath, project);
    if (rebuilt !== undefined) return rebuilt;
    sourceFile = project.program.getSourceFile(fileName);
    if (sourceFile === undefined) project.outside.add(key);
  }

  if (sourceFile !== undefined && sourceFile.text !== text) {
    project.overrides.set(key, text);
    const rebuilt = rebuild(configPath, project);
    if (rebuilt !== undefined) return rebuilt;
    sourceFile = project.program.getSourceFile(fileName);
  }

  if (sourceFile === undefined) return undefined;
  return { kind: "program", program: project.program, sourceFile };
}

/** Rebuild in place; an answer comes back only when the config went bad. */
function rebuild(
  configPath: string,
  project: Project,
): ProjectAnswer | undefined {
  const built = build(configPath, project.overrides);
  if (typeof built === "string") {
    return { kind: "broken-project", configPath, message: built };
  }
  project.program = built;
  return undefined;
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
  // A config holding no files — a solution-style root of `references`, or an
  // empty `files` list — is not a broken one: it answers for nothing, the
  // walk continues past it, and TS18002/TS18003 are how the parser says so.
  const errors = commandLine.errors.filter(
    (error) => error.code !== 18002 && error.code !== 18003,
  );
  if (errors.length > 0) return format(errors);

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

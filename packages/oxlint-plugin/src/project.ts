import { dirname } from "node:path";
import ts from "typescript";

/**
 * The ESLint host hands the rules a program its parser already built; oxlint
 * hands a plugin no type information at all, so this is the one thing the
 * adapter has to do itself: find the `tsconfig.json` that holds each file,
 * build a program from it, and keep it for the files that follow. Hosting,
 * not analysis — the same job `projectService` does on the other side, with
 * the same answer for a file no project includes.
 *
 * A program is the expensive half of that and the rarely needed one, so the
 * two questions are asked apart. *Which project holds this file* is answered
 * from the config's own globbed list, which costs a parse of the config and
 * nothing per file. *What are this file's types* is answered from a program,
 * built the first time something actually needs one — which is the first
 * marked file, and never at all in a project that has marked nothing.
 */

/** What the caller has to have: the file's types, or only where it belongs. */
export type ProjectNeed = "program" | "hosting";

export type ProjectAnswer =
  | {
      readonly kind: "program";
      readonly program: ts.Program;
      readonly sourceFile: ts.SourceFile;
    }
  /** A project holds the file, and no program was built to find that out. */
  | { readonly kind: "included" }
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
  /** The config as it was last read: options, file list and references. */
  commandLine: ts.ParsedCommandLine;
  /** That file list, keyed the way the compiler keys files. */
  rootNames: ReadonlySet<string>;
  /** Built on the first question the file list alone cannot answer. */
  program: ts.Program | undefined;
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

export function projectFor(
  fileName: string,
  text: string,
  need: ProjectNeed,
): ProjectAnswer {
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

    const answer = fromProject(configPath, fileName, text, need);
    if (answer !== undefined) return answer;

    searched = dirname(dirname(configPath));
  }
}

/** This config's answer for the file, or nothing if it does not hold it. */
function fromProject(
  configPath: string,
  fileName: string,
  text: string,
  need: ProjectNeed,
): ProjectAnswer | undefined {
  let project = projects.get(configPath);
  if (project === undefined) {
    const parsed = parse(configPath);
    if (typeof parsed === "string") {
      return { kind: "broken-project", configPath, message: parsed };
    }
    project = {
      commandLine: parsed,
      rootNames: rootNameKeys(parsed),
      program: undefined,
      overrides: new Map(),
      outside: new Set(),
    };
    projects.set(configPath, project);
  }

  const key = keyOf(fileName);

  // A file the config globbed is this config's file, and saying so needs no
  // program. Everything a program would add — what the file's types are, and
  // whether an import reaches a file the globs missed — is the other need.
  //
  // The text is kept on the way past, because a file with no mark of its own is
  // still a *dependency* of one that has them: a program built later in the run
  // has to read what the host handed over here rather than what is on disk, or
  // a marked file gets analyzed against a stale version of what it calls into.
  // Keeping it beats comparing it — the comparison is a read per file, and
  // there is nothing yet to compare against but the disk.
  //
  // Only while there is no program, though. Once one exists, the walk below is
  // where a changed buffer is noticed, and it costs a lookup rather than a read.
  if (need === "hosting" && project.program === undefined) {
    if (project.rootNames.has(key)) {
      project.overrides.set(key, text);
      return { kind: "included" };
    }
  }

  // The first program comes from the config as it was already read; only a
  // question that read one answer stale reads the config again.
  let program = (project.program ??= build(project));

  let sourceFile = program.getSourceFile(fileName);

  // A file the program has never seen may have been created since the program
  // was built, so the verdict is only settled by one fresh look — after
  // which a repeat of the same miss is answered from memory.
  if (sourceFile === undefined && !project.outside.has(key)) {
    const rebuilt = rebuild(configPath, project);
    if (typeof rebuilt === "string") {
      return { kind: "broken-project", configPath, message: rebuilt };
    }
    program = rebuilt;
    sourceFile = program.getSourceFile(fileName);
    if (sourceFile === undefined) project.outside.add(key);
  }

  if (sourceFile !== undefined && sourceFile.text !== text) {
    project.overrides.set(key, text);
    const rebuilt = rebuild(configPath, project);
    if (typeof rebuilt === "string") {
      return { kind: "broken-project", configPath, message: rebuilt };
    }
    program = rebuilt;
    sourceFile = program.getSourceFile(fileName);
  }

  if (sourceFile === undefined) return undefined;
  // A file the globs missed and an import reached is held by this config all
  // the same, and a host that only asked where it belongs is owed that answer
  // rather than the program that produced it.
  return need === "hosting"
    ? { kind: "included" }
    : { kind: "program", program, sourceFile };
}

/**
 * Re-read the config, re-glob it and build again, in place. What comes back on
 * a config that no longer parses is what is wrong with it — a project that
 * built once and has since gone bad is the same broken project a first read
 * would have reported.
 */
function rebuild(configPath: string, project: Project): ts.Program | string {
  const parsed = parse(configPath);
  if (typeof parsed === "string") return parsed;

  project.commandLine = parsed;
  project.rootNames = rootNameKeys(parsed);
  project.program = build(project);
  return project.program;
}

/** The config, read and expanded, or what is wrong with it. */
function parse(configPath: string): ts.ParsedCommandLine | string {
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
  return errors.length > 0 ? format(errors) : commandLine;
}

function build(project: Project): ts.Program {
  const { commandLine, overrides } = project;
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

/** The globbed file list, as keys inclusion can be asked of directly. */
function rootNameKeys(
  commandLine: ts.ParsedCommandLine,
): ReadonlySet<string> {
  return new Set(commandLine.fileNames.map(keyOf));
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

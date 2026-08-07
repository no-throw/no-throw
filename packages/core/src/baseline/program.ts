import type ts from "typescript";

/**
 * A live `ts.Program` over nothing but TypeScript's own libs, plus the API that
 * built it. The baseline is generated inside one of these rather than by a
 * standalone script: the remaining precision is *property-level* type
 * resolution — discharging `Array.prototype.push` needs the type of
 * `obj.length` given `obj: Array<T>` — and only a checker has it.
 *
 * The API is passed in rather than imported so the drift gate can build the
 * same inventory under a different TypeScript release.
 */
export interface LibProgram {
  readonly ts: typeof ts;
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
}

const ENTRY = "____nothrow-baseline-probe.ts";
const ENTRY_TEXT = "export {};";

export function createLibProgram(
  tsApi: typeof ts,
  libFile = "lib.esnext.d.ts",
): LibProgram {
  const host = tsApi.createCompilerHost({});
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...rest) =>
    name === ENTRY
      ? tsApi.createSourceFile(ENTRY, ENTRY_TEXT, tsApi.ScriptTarget.ESNext, true)
      : getSourceFile(name, ...rest);
  host.fileExists = (name) => name === ENTRY || tsApi.sys.fileExists(name);
  host.readFile = (name) =>
    name === ENTRY ? ENTRY_TEXT : tsApi.sys.readFile(name);

  const program = tsApi.createProgram(
    [ENTRY],
    {
      target: tsApi.ScriptTarget.ESNext,
      lib: [libFile],
      strict: true,
      noLib: false,
    },
    host,
  );

  return { ts: tsApi, program, checker: program.getTypeChecker() };
}

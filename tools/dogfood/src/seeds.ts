import { findMarks } from "@no-throw/core";
import ts from "typescript";

/**
 * A mark the harness placed. Recorded so a run can be reproduced and so the
 * report can say what was marked rather than how many.
 */
export interface Seed {
  readonly file: string;
  readonly name: string;
  /** One-based, in the file as it stood before marking. */
  readonly line: number;
}

export interface MarkedFile {
  readonly text: string;
  readonly seeds: readonly Seed[];
}

/**
 * Seeds are chosen mechanically — top-level function declarations with a body,
 * evenly spread through the file — rather than picked. A picked seed is a claim
 * about which functions are plausibly non-throwing, and the gate is not a
 * precision measurement: what it needs is that the bodies behind the marks are
 * real, so the walk has genuine work and genuine cycles to find. Spreading
 * rather than taking a prefix is what makes that true of the whole file: the
 * first fifty functions of a 7,000-line utilities module reach almost nothing.
 *
 * Declarations already carrying a mark are skipped so a second run over an
 * already-marked tree is a no-op rather than a duplicate tag.
 */
export function markSource(
  fileName: string,
  text: string,
  limit: number,
): MarkedFile {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const chosen = spread(candidates(sourceFile), limit);
  const seeds: Seed[] = chosen.map((declaration) => ({
    file: fileName,
    name: declaration.name?.text ?? "<anonymous>",
    line:
      sourceFile.getLineAndCharacterOfPosition(
        declaration.getStart(sourceFile, false),
      ).line + 1,
  }));

  // Back to front: an insertion invalidates every offset after it.
  let marked = text;
  for (const declaration of [...chosen].reverse()) {
    marked = insertMark(marked, declaration, sourceFile);
  }

  return { text: marked, seeds };
}

/**
 * Every mark the harness places has to bind, or the arm measures less work than
 * it claims to. `valid-mark`'s own view is the one that decides that, so it is
 * the one asked — a count of insertions would agree with itself and prove
 * nothing.
 */
export function assertMarksBind(
  fileName: string,
  text: string,
  expected: number,
): void {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const marks = findMarks(sourceFile);

  if (marks.problems.length > 0) {
    const kinds = marks.problems.map((problem) => problem.kind).join(", ");
    throw new Error(`${fileName}: marks failed to bind — ${kinds}`);
  }
  if (marks.bound.length !== expected) {
    throw new Error(
      `${fileName}: ${String(marks.bound.length)} marks bound, expected ${String(expected)}`,
    );
  }
}

/** `limit` of them, as evenly spaced through the list as it allows. */
function spread<T>(all: readonly T[], limit: number): readonly T[] {
  if (limit >= all.length) return all;
  const stride = all.length / limit;
  const chosen: T[] = [];
  for (let index = 0; index < limit; index += 1) {
    const item = all[Math.floor(index * stride)];
    if (item !== undefined) chosen.push(item);
  }
  return chosen;
}

function candidates(
  sourceFile: ts.SourceFile,
): readonly ts.FunctionDeclaration[] {
  const found: ts.FunctionDeclaration[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isFunctionDeclaration(statement)) continue;
    // An overload signature has no body to read, and a `declare` has no body at
    // all: marking either is a `valid-mark` problem, not a seed.
    if (statement.body === undefined) continue;
    if (ts.getJSDocTags(statement).some(isMark)) continue;
    found.push(statement);
  }
  return found;
}

function isMark(tag: ts.JSDocTag): boolean {
  return tag.tagName.text === "nothrow";
}

/**
 * Where a declaration already carries JSDoc, the tag goes inside it. A second
 * `/** *\/` block would be a mark that binds — and, in TypeScript's own
 * codebase, a `local/jsdoc-format` error, which would put a diagnostic in the
 * arm that the baseline arm does not have.
 */
function insertMark(
  text: string,
  declaration: ts.FunctionDeclaration,
  sourceFile: ts.SourceFile,
): string {
  const existing = (
    ts.getLeadingCommentRanges(text, declaration.getFullStart()) ?? []
  )
    .filter((range) => text.startsWith("/**", range.pos))
    .at(-1);

  if (existing !== undefined) {
    const indent = indentAt(text, existing.pos);
    const comment = text.slice(existing.pos, existing.end);
    return splice(text, existing.pos, existing.end, withTag(comment, indent));
  }

  const start = declaration.getStart(sourceFile, false);
  return splice(text, start, start, `/** @nothrow */\n${indentAt(text, start)}`);
}

/** The same JSDoc with `@nothrow` as its last tag. */
function withTag(comment: string, indent: string): string {
  const lastBreak = comment.lastIndexOf("\n");
  if (lastBreak === -1) {
    const body = comment.slice("/**".length, -"*/".length).trim();
    const lines = body === "" ? [] : [`${indent} * ${body}`];
    return ["/**", ...lines, `${indent} * @nothrow`, `${indent} */`].join("\n");
  }
  return (
    comment.slice(0, lastBreak) +
    `\n${indent} * @nothrow` +
    comment.slice(lastBreak)
  );
}

function indentAt(text: string, position: number): string {
  const lineStart = text.lastIndexOf("\n", position - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, position))?.[0] ?? "";
}

function splice(
  text: string,
  start: number,
  end: number,
  replacement: string,
): string {
  return text.slice(0, start) + replacement + text.slice(end);
}

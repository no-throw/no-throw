import ts from "typescript";

/**
 * The kinds of escape a marked function can be reported for. Every kind is a
 * facet of the one invariant, so adapters surface them inside a single rule
 * rather than as separate, individually disableable ones.
 */
export type FindingKind = "uncaught-throw";

export interface Finding {
  readonly kind: FindingKind;
  /** The node the diagnostic is anchored to. */
  readonly node: ts.Node;
}

/**
 * The program the analysis runs against. The core never builds one: hosts pass
 * in theirs, so the ESLint adapter shares the program typescript-eslint already
 * built and the CLI shares the one it builds itself.
 */
export interface AnalysisHost {
  readonly checker: ts.TypeChecker;
}

/**
 * Collect the escapes of `node`, if it is a marked function. Unmarked functions
 * have nothing to enforce: throwing is the default.
 */
export function analyzeFunction(
  node: ts.Node,
  host: AnalysisHost,
): readonly Finding[] {
  // The color-resolution seam takes the host's checker; the escape sites the
  // walk owns so far are answered by syntax alone, so nothing reads it yet.
  void host;

  if (!ts.isFunctionLike(node) || !isMarked(node)) return [];

  const body = (node as ts.FunctionLikeDeclaration).body;
  if (body === undefined) return [];

  const findings: Finding[] = [];
  collectEscapes(body, findings);
  return findings;
}

/**
 * Provisional mark detection: a `@nothrow` JSDoc tag as TypeScript attributes
 * it. The normative binding whitelist replaces this.
 */
function isMarked(node: ts.Node): boolean {
  return ts
    .getJSDocTags(node)
    .some((tag) => tag.tagName.escapedText === "nothrow");
}

function collectEscapes(node: ts.Node, out: Finding[]): void {
  if (ts.isThrowStatement(node) && !isBridged(node)) {
    out.push({ kind: "uncaught-throw", node });
  }

  node.forEachChild((child) => {
    // A nested function or class member is its own body with its own color.
    if (ts.isFunctionLike(child) || ts.isClassLike(child)) return;
    collectEscapes(child, out);
  });
}

/**
 * A `try` with a `catch` neutralizes escapes originating in its try block only;
 * `catch` and `finally` blocks are ordinary body code. Neutralization stops at
 * a function boundary, which the walk never crosses anyway.
 */
function isBridged(node: ts.Node): boolean {
  let child: ts.Node = node;
  let parent: ts.Node | undefined = node.parent;

  while (parent !== undefined && !ts.isFunctionLike(parent)) {
    if (
      ts.isTryStatement(parent) &&
      parent.catchClause !== undefined &&
      parent.tryBlock === child
    ) {
      return true;
    }
    child = parent;
    parent = parent.parent;
  }

  return false;
}

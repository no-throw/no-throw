/**
 * A codebase the gate is run against. Everything here is either a fact about
 * the checkout or a knob the run needs; nothing is a measurement.
 *
 * The descriptor names a commit rather than a branch: the numbers in the report
 * are only reproducible against the tree they were taken over.
 */
export interface Target {
  readonly name: string;
  readonly repository: string;
  readonly commit: string;
  /**
   * What every arm lints, checkout-relative. Both arms lint the same set, so a
   * delta is a delta in rules rather than in files.
   */
  readonly lintPaths: readonly string[];
  /**
   * Files ESLint must not visit, in either arm. `src/lib/*.d.ts` is the one
   * that matters for TypeScript: its own config turns type checking off there,
   * which would leave a type-aware rule with no program.
   */
  readonly ignorePaths: readonly string[];
  /**
   * Where seeds are drawn from, in the order they are drawn. Real functions in
   * real files: the gate is worthless if inference is handed synthetic work.
   */
  readonly seedFiles: readonly string[];
  /** The file the warm loop edits, and the seed count it runs under. */
  readonly warm: {
    readonly file: string;
    readonly seeds: number;
  };
  /**
   * The function whose cycle group the edits are claimed to change. Measured
   * before and after each edit, because "this splits a group" is a claim about
   * the graph and not something an edit can be trusted to do by looking right.
   */
  readonly cycleAnchor: string;
  /**
   * The two invalidation scenarios #30 §G names, as edits to real source. Each
   * is a literal find/replace over one file, so it can be applied, measured and
   * undone without a patch format.
   */
  readonly cycleEdits: readonly CycleEdit[];
}

export interface CycleEdit {
  readonly name: "split" | "merge";
  /** What the edit does to the cycle group, for the report. */
  readonly description: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
}

export const TARGETS: readonly Target[] = [
  {
    name: "typescript",
    repository: "https://github.com/microsoft/TypeScript",
    commit: "b465fdbfe175304d9b977da137b2c178ae1091d3",
    lintPaths: ["src"],
    ignorePaths: ["src/lib/**"],
    seedFiles: [
      "src/compiler/core.ts",
      "src/compiler/utilities.ts",
      "src/compiler/utilitiesPublic.ts",
      "src/compiler/factory/nodeTests.ts",
      "src/compiler/checker.ts",
      "src/compiler/parser.ts",
      "src/compiler/binder.ts",
      "src/compiler/emitter.ts",
      "src/services/utilities.ts",
      "src/services/services.ts",
    ],
    warm: { file: "src/compiler/utilities.ts", seeds: 400 },
    cycleAnchor: "isEntityNameExpression",
    cycleEdits: [
      {
        name: "split",
        description:
          "`isEntityNameExpression` stops calling `isPropertyAccessEntityNameExpression` " +
          "and inlines the test instead. The back edge is gone, so the two-member " +
          "group becomes two singletons.",
        file: "src/compiler/utilities.ts",
        find:
          "    return node.kind === SyntaxKind.Identifier || isPropertyAccessEntityNameExpression(node);",
        replace:
          "    return node.kind === SyntaxKind.Identifier || (isPropertyAccessExpression(node) && isIdentifier(node.name) && node.expression.kind === SyntaxKind.Identifier);",
      },
      {
        name: "merge",
        description:
          "`isEntityNameExpression` gains a call to `isBindableStaticNameExpression`, " +
          "which already reaches it. One added edge closes the path, so its group " +
          "and the assignment-declaration group become one.",
        file: "src/compiler/utilities.ts",
        find:
          "    return node.kind === SyntaxKind.Identifier || isPropertyAccessEntityNameExpression(node);",
        replace:
          "    return node.kind === SyntaxKind.Identifier || isPropertyAccessEntityNameExpression(node) || isBindableStaticNameExpression(node, /*excludeThisKeyword*/ true);",
      },
    ],
  },
];

export function targetNamed(name: string): Target {
  const target = TARGETS.find((candidate) => candidate.name === name);
  if (target === undefined) {
    throw new Error(
      `No target named ${name}; known targets: ${TARGETS.map((t) => t.name).join(", ")}`,
    );
  }
  return target;
}

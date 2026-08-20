import { readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import ts from "typescript";

export interface GraphNode {
  readonly id: number;
  readonly name: string;
  readonly file: string;
  readonly line: number;
}

export interface Group {
  readonly members: readonly GraphNode[];
}

export interface Condensation {
  readonly nodes: readonly GraphNode[];
  readonly edges: number;
  /** Strongly connected components, largest first. */
  readonly groups: readonly Group[];
}

export interface CallGraph extends Condensation {
  readonly programMs: number;
  readonly graphMs: number;
}

/**
 * The graph of a target as it stands on disk, built from the same `tsconfig.json`
 * its ESLint config names. Both bins want exactly this, and both want the two
 * timings with it — the program build is the cost the host pays and the walk is
 * the cost the gate is about.
 */
export function callGraphAt(
  targetDirectory: string,
  tsconfig: string,
  scope: string,
): CallGraph {
  const configPath = join(targetDirectory, tsconfig);
  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(configPath, (path) => readFileSync(path, "utf8")).config,
    ts.sys,
    dirname(configPath),
  );

  const started = performance.now();
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const programMs = performance.now() - started;

  const prefix = resolvePath(targetDirectory, scope).split(sep).join("/");
  const walked = performance.now();
  const graph = callGraph(program, (fileName) => fileName.startsWith(prefix));

  return {
    ...graph,
    programMs,
    graphMs: performance.now() - walked,
  };
}

/**
 * The call graph over a real program's function declarations, condensed the
 * same way the engine condenses it. This is not the engine — it resolves
 * callees by symbol and knows nothing about colors — but it answers the two
 * questions the gate has to ask of a codebase before it edits one: how big do
 * cycle groups actually get, and where is a real one to split and merge.
 */
export function callGraph(
  program: ts.Program,
  belongs: (fileName: string) => boolean,
): Condensation {
  const checker = program.getTypeChecker();
  const ids = new Map<ts.FunctionDeclaration, number>();
  const nodes: GraphNode[] = [];
  const bodies: ts.FunctionDeclaration[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || !belongs(sourceFile.fileName)) continue;
    forEachFunction(sourceFile, (declaration) => {
      const { line } = sourceFile.getLineAndCharacterOfPosition(
        declaration.getStart(sourceFile, false),
      );
      ids.set(declaration, nodes.length);
      nodes.push({
        id: nodes.length,
        name: declaration.name?.text ?? "<anonymous>",
        file: sourceFile.fileName,
        line: line + 1,
      });
      bodies.push(declaration);
    });
  }

  let edges = 0;
  const successors: number[][] = bodies.map((declaration) => {
    const out = new Set<number>();
    forEachCall(declaration, (call) => {
      const target = resolve(checker, call.expression);
      const id = target === undefined ? undefined : ids.get(target);
      if (id !== undefined) out.add(id);
    });
    edges += out.size;
    return [...out];
  });

  const groups = condense(successors)
    .map((members) => ({ members: members.map((id) => atIndex(nodes, id)) }))
    .sort((a, b) => b.members.length - a.members.length);

  return { nodes, edges, groups };
}

/** Every function declaration with a body, at any depth. */
function forEachFunction(
  root: ts.Node,
  visit: (declaration: ts.FunctionDeclaration) => void,
): void {
  root.forEachChild(function walk(node) {
    if (ts.isFunctionDeclaration(node) && node.body !== undefined) visit(node);
    node.forEachChild(walk);
  });
}

/**
 * Calls this body makes itself. A call inside a nested function is that
 * function's, not this one's — the same boundary the escape walk draws, and the
 * reason a callback does not put its callee in the caller's group.
 */
function forEachCall(
  declaration: ts.FunctionDeclaration,
  visit: (call: ts.CallExpression) => void,
): void {
  declaration.body?.forEachChild(function walk(node) {
    if (ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) visit(node);
    node.forEachChild(walk);
  });
}

function resolve(
  checker: ts.TypeChecker,
  callee: ts.Expression,
): ts.FunctionDeclaration | undefined {
  const symbol = checker.getSymbolAtLocation(callee);
  const aliased =
    symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  return aliased?.declarations?.find(
    (declaration): declaration is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(declaration) && declaration.body !== undefined,
  );
}

/**
 * Tarjan, iteratively. Recursion is what the engine uses and what the graph
 * would blow on here: TypeScript's own compiler has bodies deep enough to
 * exhaust the stack at this scale.
 *
 * Every per-node read goes through `atIndex`. A `?? 0` on `lowlink` would not
 * be a default, it would be a wrong answer the algorithm then propagates.
 */
function condense(successors: readonly (readonly number[])[]): number[][] {
  const index = new Array<number>(successors.length).fill(-1);
  const lowlink = new Array<number>(successors.length).fill(0);
  const onStack = new Array<boolean>(successors.length).fill(false);
  const stack: number[] = [];
  const groups: number[][] = [];
  let next = 0;

  for (let root = 0; root < successors.length; root += 1) {
    if (atIndex(index, root) !== -1) continue;

    const work: { node: number; edge: number }[] = [{ node: root, edge: 0 }];
    index[root] = lowlink[root] = next++;
    stack.push(root);
    onStack[root] = true;

    while (work.length > 0) {
      const frame = atIndex(work, work.length - 1);
      const out = atIndex(successors, frame.node);

      if (frame.edge < out.length) {
        const child = atIndex(out, frame.edge);
        frame.edge += 1;
        if (atIndex(index, child) === -1) {
          index[child] = lowlink[child] = next++;
          stack.push(child);
          onStack[child] = true;
          work.push({ node: child, edge: 0 });
        } else if (atIndex(onStack, child)) {
          lowlink[frame.node] = Math.min(
            atIndex(lowlink, frame.node),
            atIndex(index, child),
          );
        }
        continue;
      }

      work.pop();
      if (work.length > 0) {
        const parent = atIndex(work, work.length - 1);
        lowlink[parent.node] = Math.min(
          atIndex(lowlink, parent.node),
          atIndex(lowlink, frame.node),
        );
      }
      if (atIndex(lowlink, frame.node) === atIndex(index, frame.node)) {
        const group: number[] = [];
        for (;;) {
          const member = stack.pop();
          if (member === undefined) break;
          onStack[member] = false;
          group.push(member);
          if (member === frame.node) break;
        }
        groups.push(group);
      }
    }
  }

  return groups;
}

/**
 * An element at an index the caller has already bounded. A miss is a bug in the
 * caller rather than a value anything here could stand in for.
 */
function atIndex<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) {
    throw new Error(`index ${String(index)} is out of range`);
  }
  return item;
}

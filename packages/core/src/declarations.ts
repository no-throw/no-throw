import ts from "typescript";

/**
 * A declaration a color can be read off by reading source. A class is one of
 * them: `new C()` runs C's field initializers and, when C declares no
 * constructor, its base's effective body — and neither has a signature
 * declaration to stand for it.
 */
export type Bodied = ts.SignatureDeclaration | ts.ClassLikeDeclaration;

/**
 * The declaration's body, or `undefined` where there is none to read a color
 * off: an overload, an interface method, a `.d.ts` declaration, the type of a
 * parameter.
 */
export function bodyOf(
  declaration: ts.SignatureDeclaration,
): ts.Block | ts.Expression | undefined {
  return (declaration as ts.FunctionLikeDeclaration).body;
}

/**
 * A `function*` or `*method()`: the one declaration kind whose body does not
 * run at the call. Its parameter list still does, which is why the split is a
 * split of *regions* and not a second kind of escape site.
 */
export function isGenerator(declaration: Bodied): boolean {
  if (ts.isClassLike(declaration)) return false;
  return (declaration as ts.FunctionLikeDeclaration).asteriskToken !== undefined;
}

/**
 * Every expression a `return` in this body hands back, the implicit return of
 * an expression-bodied arrow included. Nested functions are skipped: their
 * returns are their own.
 */
export function returnedExpressions(
  declaration: Bodied,
): readonly ts.Expression[] {
  if (ts.isClassLike(declaration)) return [];

  const body = bodyOf(declaration);
  if (body === undefined) return [];
  if (!ts.isBlock(body)) return [body];

  const returned: ts.Expression[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isReturnStatement(node)) {
      if (node.expression !== undefined) returned.push(node.expression);
      return;
    }
    node.forEachChild((child) => {
      if (ts.isFunctionLike(child) || ts.isClassLike(child)) return;
      walk(child);
    });
  };

  walk(body);
  return returned;
}

/**
 * The constructor a class declares, if it declares one. An overload signature
 * is not it where an implementation exists: the implementation is what runs.
 *
 * Where none exists the declaration is taken anyway, because a `.d.ts` has
 * nothing else — and it is the node a carrier answers for. Emit keys a marked
 * constructor `Wrapper#new()`, so a read that fell back to the class here would
 * ask the manifest for `Wrapper` and never find the entry the package shipped.
 */
function declaredConstructor(
  classLike: ts.ClassLikeDeclaration,
): ts.ConstructorDeclaration | undefined {
  const declared = classLike.members.filter(ts.isConstructorDeclaration);
  return declared.find((member) => member.body !== undefined) ?? declared[0];
}

/**
 * The body `new C()` enters. A declared constructor is that body — the class's
 * field initializers are part of it, not a separate escape kind. A class that
 * declares none has no such node, so the class itself stands for the field
 * initializers plus the implicit `super()`.
 */
export function constructedBody(classLike: ts.ClassLikeDeclaration): Bodied {
  return declaredConstructor(classLike) ?? classLike;
}

/** The `extends` expression, or nothing where the class has no base. */
export function baseClassExpression(
  classLike: ts.ClassLikeDeclaration,
): ts.Expression | undefined {
  const extended = classLike.heritageClauses?.find(
    (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
  );
  return extended?.types[0]?.expression;
}

/**
 * What a `super()` written at this node enters: the `extends` expression of the
 * class around it. Both the body it resolves to and the name the diagnostic
 * quotes are read off this, because `super` itself names nothing.
 */
export function inheritedFrom(node: ts.Node): ts.Expression | undefined {
  for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) {
    if (ts.isClassLike(n)) return baseClassExpression(n);
  }
  return undefined;
}

/**
 * Whether there is source behind the declaration to read a color off. An
 * ambient class is the class-shaped bodyless declaration: its field
 * initializers and its implicit `super()` are exactly what a `.d.ts` does not
 * carry, so believing the empty walk would be believing silence.
 */
export function hasVisibleBody(declaration: Bodied): boolean {
  return ts.isClassLike(declaration)
    ? !isAmbient(declaration)
    : bodyOf(declaration) !== undefined;
}

/**
 * The initializers that run once per instance, which is constructor body:
 * `new C()` is the escape site that reaches them, however far from the class
 * it is written.
 */
export function fieldInitializers(
  classLike: ts.ClassLikeDeclaration,
): readonly ts.Expression[] {
  const initializers: ts.Expression[] = [];

  for (const member of classLike.members) {
    if (
      ts.isPropertyDeclaration(member) &&
      member.initializer !== undefined &&
      !isStatic(member)
    ) {
      initializers.push(member.initializer);
    }
  }

  return initializers;
}

/**
 * What *evaluating* the class runs, as against constructing one: decorators,
 * the heritage expression, computed member keys, static field initializers and
 * `static {}` blocks. All of it runs where the class is written, so it is body
 * code of whatever body the class is written in. Module evaluation needs no
 * test of its own here — a class at module level is written where nothing
 * walks, which is the whole of the scope statement.
 */
export function classEvaluation(
  classLike: ts.ClassLikeDeclaration,
): readonly ts.Node[] {
  const evaluated: ts.Node[] = [...decorators(classLike)];

  const base = baseClassExpression(classLike);
  if (base !== undefined) evaluated.push(base);

  for (const member of classLike.members) {
    evaluated.push(...decorators(member));

    if (ts.isClassStaticBlockDeclaration(member)) {
      evaluated.push(member.body);
      continue;
    }
    if (member.name !== undefined && ts.isComputedPropertyName(member.name)) {
      evaluated.push(member.name.expression);
    }
    if (
      ts.isPropertyDeclaration(member) &&
      member.initializer !== undefined &&
      isStatic(member)
    ) {
      evaluated.push(member.initializer);
    }
  }

  return evaluated;
}

function isStatic(member: ts.ClassElement): boolean {
  return (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) !== 0;
}

function decorators(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
}

/**
 * `declare`, anywhere above the node, and every declaration in a `.d.ts`. The
 * modifier is read syntactically rather than off `NodeFlags.Ambient`, which
 * TypeScript does not expose.
 */
export function isAmbient(node: ts.Node): boolean {
  if (node.getSourceFile().isDeclarationFile) return true;
  for (let n: ts.Node | undefined = node; n !== undefined; n = n.parent) {
    if (hasModifier(n, ts.SyntaxKind.DeclareKeyword)) return true;
  }
  return false;
}

/** Whether the declaration carries a modifier, for nodes that can hold any. */
export function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return (
    ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true
  );
}

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
 * The constructor a class implements, if it implements one. An overload
 * signature is not it: the implementation is what runs.
 */
function declaredConstructor(
  classLike: ts.ClassLikeDeclaration,
): ts.ConstructorDeclaration | undefined {
  return classLike.members.find(
    (member): member is ts.ConstructorDeclaration =>
      ts.isConstructorDeclaration(member) && member.body !== undefined,
  );
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
 * The initializers that run once per instance. A `static` field, a `static {}`
 * block and a computed key all run when the class is defined, which is module
 * evaluation and outside the color model — so the initializer alone is body.
 */
export function fieldInitializers(
  classLike: ts.ClassLikeDeclaration,
): readonly ts.Expression[] {
  const initializers: ts.Expression[] = [];

  for (const member of classLike.members) {
    if (!ts.isPropertyDeclaration(member) || member.initializer === undefined) {
      continue;
    }
    const modifiers = ts.getCombinedModifierFlags(member);
    if ((modifiers & ts.ModifierFlags.Static) === 0) {
      initializers.push(member.initializer);
    }
  }

  return initializers;
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

export function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return (
    ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true
  );
}

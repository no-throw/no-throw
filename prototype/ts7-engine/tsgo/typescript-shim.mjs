/**
 * A `typescript` module that is really TypeScript 7.
 *
 * `@nothrow/core` reaches the compiler two ways: type questions, which #81 put
 * behind the `TypeFacts` port, and *syntax*, which it reads directly as
 * `ts.isCallExpression` and friends. The second is what this stands in for.
 *
 * It is a shim rather than a port on purpose, and the measurements are why: the
 * TypeScript 7 AST is materialized client-side and costs no round trips at all,
 * so there is nothing to batch and nothing to hide. What is left is a naming
 * difference, and #81 measured it at five names out of the fifty-seven
 * predicates the engine uses.
 *
 * Substituting a module is not how this would ship — it is how the claim "the
 * syntax layer is portable" gets tested instead of asserted.
 */
import * as ast from "@typescript/native-preview/unstable/ast";
import * as sync from "@typescript/native-preview/unstable/sync";

const { SyntaxKind, NodeFlags, ModifierFlags } = ast;

/**
 * The five the engine names differently. TypeScript's `isFunctionLike` admits
 * bodyless signatures and tsgo's `isFunctionLikeDeclaration` does not, so that
 * one is widened rather than aliased — the engine leans on the wider reading
 * everywhere it asks whether a declaration has a parameter list at all.
 */
const SIGNATURE_KINDS = new Set([
  SyntaxKind.CallSignature,
  SyntaxKind.ConstructSignature,
  SyntaxKind.MethodSignature,
  SyntaxKind.IndexSignature,
  SyntaxKind.FunctionType,
  SyntaxKind.ConstructorType,
]);

const renamed = {
  isClassLike: ast.isClassLikeDeclaration,
  isMethodSignature: ast.isMethodSignatureDeclaration,
  isParameter: ast.isParameterDeclaration,
  isPropertySignature: ast.isPropertySignatureDeclaration,
  isFunctionLike: (node) =>
    node !== undefined &&
    (ast.isFunctionLikeDeclaration(node) || SIGNATURE_KINDS.has(node.kind)),
};

/**
 * The module-level helpers tsgo does not export. Every one is a walk over node
 * members the AST does expose, which is what makes them shimmable rather than
 * blockers — #81's surface probe checks that data is present before this file
 * is trusted.
 */
const helpers = {
  getModifiers: (node) => node.modifiers?.filter(ast.isModifier),

  getDecorators: (node) => node.modifiers?.filter(ast.isDecorator),

  canHaveModifiers: (node) => node.modifiers !== undefined,

  canHaveDecorators: (node) => node.modifiers !== undefined,

  getNameOfDeclaration: (declaration) => declaration?.name,

  /**
   * Modifiers as the *declaration* has them, which for a variable is written on
   * the statement two levels up.
   */
  getCombinedModifierFlags: (node) => {
    let flags = 0;
    for (const modifier of node.modifiers ?? []) {
      flags |= MODIFIER_FLAG[modifier.kind] ?? 0;
    }
    let current = node;
    while (
      current.parent !== undefined &&
      (current.parent.kind === SyntaxKind.VariableDeclarationList ||
        current.parent.kind === SyntaxKind.VariableStatement)
    ) {
      current = current.parent;
      for (const modifier of current.modifiers ?? []) {
        flags |= MODIFIER_FLAG[modifier.kind] ?? 0;
      }
    }
    return flags;
  },

  /** `const` is on the declaration *list*, never on the declaration. */
  getCombinedNodeFlags: (node) => {
    let flags = node.flags;
    let current = node;
    while (
      current.parent !== undefined &&
      (current.parent.kind === SyntaxKind.VariableDeclarationList ||
        current.parent.kind === SyntaxKind.VariableStatement)
    ) {
      current = current.parent;
      flags |= current.flags;
    }
    return flags;
  },
};

const MODIFIER_FLAG = {
  [SyntaxKind.StaticKeyword]: ModifierFlags.Static,
  [SyntaxKind.AbstractKeyword]: ModifierFlags.Abstract,
  [SyntaxKind.ReadonlyKeyword]: ModifierFlags.Readonly,
  [SyntaxKind.DeclareKeyword]: ModifierFlags.Ambient,
  [SyntaxKind.AsyncKeyword]: ModifierFlags.Async,
  [SyntaxKind.ExportKeyword]: ModifierFlags.Export,
  [SyntaxKind.PublicKeyword]: ModifierFlags.Public,
  [SyntaxKind.PrivateKeyword]: ModifierFlags.Private,
  [SyntaxKind.ProtectedKeyword]: ModifierFlags.Protected,
};

const ts = {
  ...ast,
  ...renamed,
  ...helpers,
  SyntaxKind,
  NodeFlags,
  ModifierFlags,
  SymbolFlags: sync.SymbolFlags,
  TypeFlags: sync.TypeFlags,
};

export default ts;
export const {
  SyntaxKind: SyntaxKindExport,
  NodeFlags: NodeFlagsExport,
} = ts;

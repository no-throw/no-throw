// color-engine.mjs — THROWAWAY spike (no-throw ticket #6)
//
// The portable logic being prototyped: the hybrid color model (#4) + the
// @nothrow carrier (#5), expressed over the raw TypeScript checker so it can be
// driven from *either* a typescript-eslint rule OR a standalone program.
//
// Color of a function ∈ { 'non-throwing', 'throwing' }.
//   - marked with `@nothrow`            → non-throwing (a SEED; body is enforced)
//   - unmarked, body visible & provably clean → non-throwing (INFERRED)
//   - unmarked, throws can escape        → throwing (inferred)
//   - opaque (no body: ambient / .d.ts / external) → throwing (the sound floor)
//
// Enforcement (only SEEDS are flagged): a seed must have no *escaping* throw —
//   (a) no uncaught `throw`, and
//   (b) every call to a THROWING function bridged by a try/catch.

import ts from 'typescript';

/** Does this declaration carry the `@nothrow` mark (the seed carrier, #5)? */
export function isMarked(decl) {
  if (!decl) return false;
  return ts.getJSDocTags(decl).some((t) => t.tagName?.text === 'nothrow');
}

/** Resolve the function-like declaration a call target points at (following import aliases). */
function getTargetDecl(calleeNode, checker) {
  let sym = checker.getSymbolAtLocation(calleeNode);
  if (!sym) return undefined;
  if (sym.flags & ts.SymbolFlags.Alias) {
    try {
      sym = checker.getAliasedSymbol(sym);
    } catch {
      /* not aliased after all */
    }
  }
  const decls = sym.getDeclarations() ?? [];
  return decls.find((d) => ts.isFunctionLike(d));
}

/**
 * Is `node` bridged — lexically inside the try-block of a try/catch that lives
 * in the *same* function? Conservative: presence of a catch clause = bridged
 * (rethrow / catch-side escapes are a known hole, see NOTES.md).
 */
function isBridged(node) {
  let child = node;
  let parent = node.parent;
  while (parent) {
    if (ts.isFunctionLike(parent)) return false; // crossed the function boundary
    if (ts.isTryStatement(parent) && parent.tryBlock === child && parent.catchClause) {
      return true;
    }
    child = parent;
    parent = parent.parent;
  }
  return false;
}

/**
 * Walk a function body (NOT descending into nested functions — separate scopes)
 * and collect every throw that would escape the color contract.
 * Returns [{ node, kind: 'throw' } | { node, kind: 'call', name }].
 */
export function collectEscapes(fnDecl, checker, memo = new Map(), stack = new Set()) {
  const body = fnDecl.body;
  if (!body) return [];
  const escapes = [];

  const visit = (node) => {
    if (ts.isThrowStatement(node)) {
      if (!isBridged(node)) escapes.push({ node, kind: 'throw' });
    } else if (ts.isCallExpression(node)) {
      const target = getTargetDecl(node.expression, checker);
      if (resolveColor(target, checker, memo, stack) === 'throwing' && !isBridged(node)) {
        escapes.push({ node, kind: 'call', name: node.expression.getText() });
      }
    }
    ts.forEachChild(node, (child) => {
      if (ts.isFunctionLike(child)) return; // nested scope: its own contract
      visit(child);
    });
  };

  visit(body);
  return escapes;
}

/** Resolve a declaration's color under the hybrid model (mark seeds + infer the rest). */
export function resolveColor(decl, checker, memo = new Map(), stack = new Set()) {
  if (!decl) return 'throwing'; // unresolved / opaque
  if (isMarked(decl)) return 'non-throwing'; // trust the mark; body enforced separately
  if (!decl.body) return 'throwing'; // ambient / .d.ts / external — sound floor
  if (memo.has(decl)) return memo.get(decl);
  if (stack.has(decl)) return 'non-throwing'; // recursion cycle: optimistic fixpoint

  stack.add(decl);
  const escapes = collectEscapes(decl, checker, memo, stack);
  stack.delete(decl);

  const color = escapes.length === 0 ? 'non-throwing' : 'throwing';
  memo.set(decl, color);
  return color;
}

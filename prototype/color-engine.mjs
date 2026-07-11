// color-engine.mjs — THROWAWAY spike (no-throw tickets #6 + #15)
//
// The portable logic being prototyped: the hybrid color model (#4) + the
// @nothrow carrier (#5), expressed over the raw TypeScript checker so it can be
// driven from *either* a typescript-eslint rule OR a standalone program.
//
// Color of a function ∈ { 'non-throwing', 'throwing' }.
//   - marked with `@nothrow`            → non-throwing (a SEED; body is enforced)
//   - unmarked, body visible & provably clean → non-throwing (INFERRED)
//   - unmarked, throws can escape        → throwing (inferred)
//   - opaque (no body: ambient / .d.ts / external) → throwing (the sound floor),
//     UNLESS an injected manifest lookup (#15, opts.resolveOpaque) vouches for it
//
// Enforcement (only SEEDS are flagged): a seed must have no *escaping* throw —
//   (a) no uncaught `throw`, and
//   (b) every call to a THROWING function bridged by a try/catch.
//
// Async amendment (#12), minimal cut for the #15 spike:
//   - a promise-producing call escapes when awaited-unbridged, floated at
//     statement position, or left as an unawaited value (floored)
//   - `try { f() } catch` WITHOUT await bridges nothing (the fake-bridge trap)
//   - a terminal `.catch(h)` is the async bridge — sound only when the head is
//     SYNC-SAFE (visibly async, or manifest `async: true`) and `h` is non-throwing
//
// opts (trailing param on the public functions, default {}):
//   resolveOpaque?: (decl) => { color, async? } | undefined
//       manifest lookup for bodyless decls — enters through the same seam as
//       inference (#4), so the engine itself stays fs-free
//   ignoreAsyncFlag?: boolean
//       counterfactual switch for the report: pretend the manifest carries no
//       async bit (shows the flag is load-bearing)

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
 * (rethrow / catch-side escapes are a known hole, see NOTES.md → #14).
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

function isVisiblyAsync(decl) {
  return !!decl?.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
}

/** Does this call produce a Promise? (spike heuristic: type symbol named Promise) */
function isPromiseTyped(node, checker) {
  const type = checker.getTypeAtLocation(node);
  const name = type?.aliasSymbol?.getName?.() ?? type?.symbol?.getName?.();
  return name === 'Promise';
}

/**
 * Facts about a call's target: its color, plus whether it provably cannot throw
 * SYNCHRONOUSLY (the #12 witness the `.catch` bridge hangs on). Opaque decls ask
 * the injected manifest first, then fall to the sound floor.
 */
function targetFacts(callNode, checker, memo, stack, opts) {
  const decl = getTargetDecl(callNode.expression, checker);
  if (decl && !decl.body && !isMarked(decl)) {
    const entry = opts.resolveOpaque?.(decl);
    if (entry) {
      return {
        color: entry.color,
        syncSafe: entry.async === true && !opts.ignoreAsyncFlag,
        origin: 'manifest',
      };
    }
    return { color: 'throwing', syncSafe: false, origin: 'floor' };
  }
  return {
    color: resolveColor(decl, checker, memo, stack, opts),
    // non-throwing = FULL surface (#12): never sync-throws either
    syncSafe: isVisiblyAsync(decl) || resolveColor(decl, checker, memo, stack, opts) === 'non-throwing',
    origin: decl ? (isMarked(decl) ? 'declared' : 'inferred') : 'floor',
  };
}

/** Color of a `.catch` handler argument: inline function or resolvable reference. */
function handlerColor(arg, checker, memo, stack, opts) {
  if (!arg) return 'throwing';
  if (ts.isFunctionLike(arg)) return resolveColor(arg, checker, memo, stack, opts);
  return resolveColor(getTargetDecl(arg, checker), checker, memo, stack, opts);
}

/** Match `head(...).catch(h)` — the #12 async bridge shape. */
function asCatchBridge(node) {
  const callee = node.expression;
  if (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'catch' &&
    ts.isCallExpression(callee.expression)
  ) {
    return { head: callee.expression, handler: node.arguments[0] };
  }
  return undefined;
}

/**
 * Walk a function body (NOT descending into nested functions — separate scopes)
 * and collect every throw that would escape the color contract.
 * Returns [{ node, kind: 'throw' } | { node, kind: 'call', name, reason }].
 */
export function collectEscapes(fnDecl, checker, memo = new Map(), stack = new Set(), opts = {}) {
  const body = fnDecl.body;
  if (!body) return [];
  const escapes = [];
  const handledByCatchBridge = new Set(); // head calls consumed by a valid/judged .catch

  const visit = (node) => {
    if (ts.isThrowStatement(node)) {
      if (!isBridged(node)) escapes.push({ node, kind: 'throw' });
    } else if (ts.isCallExpression(node) && !handledByCatchBridge.has(node)) {
      const bridge = asCatchBridge(node);
      if (bridge) {
        handledByCatchBridge.add(bridge.head);
        const head = targetFacts(bridge.head, checker, memo, stack, opts);
        if (head.color === 'throwing' && !head.syncSafe) {
          escapes.push({
            node,
            kind: 'call',
            name: bridge.head.expression.getText(),
            reason: '.catch head may throw synchronously (no async witness)',
          });
        } else if (handlerColor(bridge.handler, checker, memo, stack, opts) !== 'non-throwing') {
          escapes.push({
            node,
            kind: 'call',
            name: node.expression.getText(),
            reason: '.catch handler is itself throwing',
          });
        }
        // valid async bridge: the chain's result is non-throwing — nothing escapes
      } else if (!isPromiseTyped(node, checker)) {
        // sync call — the original #6 rule
        if (targetFacts(node, checker, memo, stack, opts).color === 'throwing' && !isBridged(node)) {
          escapes.push({
            node,
            kind: 'call',
            name: node.expression.getText(),
            reason: 'bare call to throwing function',
          });
        }
      } else {
        const facts = targetFacts(node, checker, memo, stack, opts);
        const awaited = ts.isAwaitExpression(node.parent) && node.parent.expression === node;
        if (awaited) {
          if (facts.color === 'throwing' && !isBridged(node)) {
            escapes.push({
              node,
              kind: 'call',
              name: node.expression.getText(),
              reason: 'awaited throwing call, unbridged',
            });
          }
        } else if (facts.color === 'throwing') {
          // no await, no .catch: try/catch around it bridges NOTHING (#12)
          escapes.push({
            node,
            kind: 'call',
            name: node.expression.getText(),
            reason: ts.isExpressionStatement(node.parent)
              ? 'floating promise from throwing call (Tier-1 float, #12)'
              : 'unawaited promise from throwing call (floored, #12)',
          });
        }
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
export function resolveColor(decl, checker, memo = new Map(), stack = new Set(), opts = {}) {
  if (!decl) return 'throwing'; // unresolved / opaque
  if (isMarked(decl)) return 'non-throwing'; // trust the mark; body enforced separately
  if (!decl.body) return opts.resolveOpaque?.(decl)?.color ?? 'throwing'; // floor, unless the manifest vouches
  if (memo.has(decl)) return memo.get(decl);
  if (stack.has(decl)) return 'non-throwing'; // recursion cycle: optimistic fixpoint

  stack.add(decl);
  const escapes = collectEscapes(decl, checker, memo, stack, opts);
  stack.delete(decl);

  const color = escapes.length === 0 ? 'non-throwing' : 'throwing';
  memo.set(decl, color);
  return color;
}

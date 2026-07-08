# Capability matrix: what a type-aware `typescript-eslint` rule can enforce for throwing/non-throwing coloring

_Resolves ticket #3 ("Probe what a typescript-eslint rule can actually enforce"). Feeds #4 (infer vs. declare) and #5 (carrier for the mark)._

**Method:** throwaway spike rules + compiler-API probes against the real type checker, cross-checked with primary-source docs. Every row below is either **empirically verified** in the spike or **doc-sourced** (URL given). Spike sources are archived under `research/spikes/03/`.

**Environment:** `typescript@5.9.3`, `@typescript-eslint/parser@8.63.0`, `@typescript-eslint/typescript-estree@8.63.0`, Node v22.12.

---

## Bottom line

- **A rule has everything it needs.** Full whole-program type checker via `ParserServices`; cross-file and cross-`.d.ts` symbol/type reads work; `try/catch` scoping is trivial AST; `await`/Promise unwrapping is a public checker call. **No capability required by the rule is impossible.**
- **Both carrier options are readable cross-package** — but with a decisive asymmetry: the **type-brand survives a shipped `.d.ts` unconditionally**, whereas the **JSDoc `@nothrow` tag is silently stripped when a library compiles with `removeComments: true`**. This is the single biggest constraint the design must absorb (see [Carrier comparison](#carrier-comparison)).
- **Inference does _not_ blow up.** The standing "transitive analysis is a perf non-starter" suspicion is **refuted**: whole-program, memoized transitive throwing-analysis over 2000 functions / 40 files ran in **~50 ms**. The dominant cost (~700 ms) is the TypeScript program build — which type-aware linting pays anyway. The only way to make it explode is to omit memoization.
- **One hard limit from TypeScript itself:** the type system **does not model rejection** — a `Promise<T>` carries no "may reject" information. "Awaited rejection = throwing call" is therefore enforceable via _our color_ (brand/tag/inference on the callee), **not** derivable from Promise types. This bounds the async design.

---

## Capability matrix

| # | Capability the rule needs | Verdict | How / caveat |
|---|---|---|---|
| 0 | Get the type checker inside a rule | ✅ verified | `ESLintUtils.getParserServices(context)` → `services.program.getTypeChecker()`, `esTreeNodeToTSNodeMap.get(esNode)`. Requires `parserOptions.projectService: true` (or legacy `project`). [docs](https://typescript-eslint.io/developers/custom-rules) |
| 1a | Read an **imported** function's color from a **type-brand** return type | ✅ verified | Return type resolves to `string & { readonly [NOTHROW]?: true }` across module **and** compiled-`.d.ts** boundaries; brand detected via `returnType.getProperties()` (symbol-keyed prop `escapedName` contains the brand). Note: the `Safe<T>` **alias name is erased** by the time you read the return type (`aliasSymbol` was `null`) — detect the **brand property**, not the alias name. |
| 1b | Read an **imported** function's color from a **JSDoc `@nothrow`** tag | ✅ verified, ⚠️ conditional | `symbol.getJsDocTags(checker)` returns `["nothrow"]` — **but only after `checker.getAliasedSymbol(importSym)`** (the import gives an alias symbol; tags live on the original). Custom (non-standard) tags _do_ come back (this resolves the ambiguity flagged in the docs). Cross-package it **also depends on the tag surviving into the `.d.ts`** — see 1c. |
| 1c | `@nothrow` survives into a shipped `.d.ts` | ⚠️ **fragile** | Survives with default emit; **stripped by `removeComments: true`** (verified: `nothrowSurvives:false`). TS closed the "preserve significant tags regardless" request as out-of-scope ([TS#51177](https://github.com/microsoft/TypeScript/issues/51177)). No way to force-preserve. Type-brand has no such failure mode. |
| 2 | Infer color by walking a function's body + transitive callees | ✅ verified, performant | Uncaught `throw` or unguarded throwing call ⇒ throwing, resolved transitively cross-file. See [Performance](#performance-inference-feasibility). Cycles need a guard (see [Constraints](#constraints-holes--decisions-this-forces)). |
| 3 | Detect that an `await`ed call may reject (is a throwing call) | ✅ verified (structurally) | `checker.getAwaitedType(t)` / `getPromisedTypeOfPromise(t)` unwrap the Promise; the callee's color (brand survives through the `Promise<Safe<…>>` layer — verified) or tag/inference decides. ⚠️ TS carries **no rejection type**, so "may reject" comes from _our_ color, never from `Promise<T>` itself. `getAwaitedType` is public/documented; prefer it over `getPromisedTypeOfPromise` (internal-ish). |
| 4 | Tell whether a throwing call sits inside a `catch`-ing `try` (the sanctioned bridge) | ✅ verified | Pure **AST** parent-walk — no type info. Correctly distinguished guarded (`insideCatchingTry:true`) vs. unguarded call sites for both sync (`mustParse`) and `await` (`fetchThing`) cases. Must check the call is in the `try` **block** (not the `catch`/`finally`) and the `try` has a `handler`. |

---

## Carrier comparison (feeds #5)

| | Type-brand `Safe<T>` | JSDoc `@nothrow` |
|---|---|---|
| Read locally by rule | ✅ | ✅ |
| Read cross-file (same program) | ✅ | ✅ (after `getAliasedSymbol`) |
| Read across a **shipped `.d.ts`** | ✅ **unconditional** | ⚠️ **only if lib didn't set `removeComments`** |
| Type/runtime footprint | Non-zero: appears in signatures, can leak into inferred types / hovers | **Zero** — pure comment, invisible to types |
| Failure mode | Type noise | **Silent** color loss across a package boundary |

This is the core tension the standing steer named: the design _wants_ zero-footprint (favoring JSDoc), but the **only** carrier that is robust across the third-party boundary is the type-brand. #5 must resolve this — options include: brand-only; JSDoc-primary with a brand fallback for published types; or a lint-side sidecar (allowlist/overlay) that doesn't rely on the shipped artifact at all (ties into the "third-party boundary" fog).

## Performance (inference feasibility — the #2/#4 blocker)

Synthetic DAG: **2000 functions, 40 files, fan-out 3**, one leaf that throws propagating up (286 functions end up throwing). Measured on Node v22 / TS 5.9.

| Scenario | Time | Fn visits | Call resolutions |
|---|---|---|---|
| `createProgram` + `getTypeChecker` (one-time) | **~700 ms** | — | — |
| Whole-program transitive analysis, **global memo** | **~50 ms** | 2 000 (linear) | 5 391 |
| Per-file analysis, **no cross-file memo persistence** (naïve ESLint model) | ~282 ms | 41 000 (20×) | 109 770 |

**Reading:** the analysis itself is cheap and **linear** in functions with a memo keyed by declaration node. The build cost dwarfs it and is unavoidable for _any_ type-aware rule ("lint time ≈ build time", [docs](https://typescript-eslint.io/troubleshooting/typed-linting/performance/)). The realistic risk is ESLint's **per-file** rule invocation: without a cache that persists across files in one run, work is re-done (~5× here). A **module-level memo** in the rule file (persists across files within a single ESLint run) neutralizes it → back to ~50 ms. **The exponential blow-up only occurs with zero memoization** (re-recursing at every call site); no reasonable implementation does that. → **Inference is on the table as a real option; it is not a perf non-starter.**

## Constraints, holes & decisions this forces

- **Rejection is not typed.** (Q3) Async coloring must ride on the callee's color, not on `Promise<T>`. Constrains #4/#5 and the async fog.
- **`removeComments` strips JSDoc.** (1c) Any JSDoc carrier needs a cross-package answer, or the design leans on the type-brand for published surfaces.
- **Alias-name erasure.** (1a) Brand detection must key on a **structural marker** (a symbol-keyed property), not on the `Safe` alias name, which the checker discards.
- **Multi-block JSDoc & tag-retrieval gaps.** `ts.getJSDocTags(node)` only sees the JSDoc block immediately attached; stacked blocks need the unsupported `(node as any).jsDoc`. `symbol.getJsDocTags(checker)` was reliable in the spike. ([TS#42895](https://github.com/microsoft/TypeScript/issues/42895))
- **Cycles / mutual recursion.** The transitive walk needs a cycle guard; the spike assumed "in-progress ⇒ non-throwing" to break loops. That is a **soundness choice** (a throw reachable only through a recursive cycle could be missed) — flag for the enforcement-engine design.
- **`projectService` out-of-project files** build a fresh program each (cap 8), a perf cliff for files outside the tsconfig. ([docs](https://typescript-eslint.io/troubleshooting/typed-linting/))

## Reproduce

Spikes archived under `research/spikes/03/` (`spike.js` cross-file reads + try/catch + await; `spike2.js` compiled-`.d.ts` boundary + alias JSDoc; `perf.js`/`perf2.js` transitive-inference timing; `dts_strip.js` `removeComments` test; `gen.js` graph generator; `src/` fixtures). Run `npm i` then `node <spike>.js`.

# Prior art: tracking "can throw" across the call graph in TS/JS

**Question this answers:** Who has already built "a non-throwing function may only call non-throwing functions" (or a close equivalent) for TS/JS — and does any of it make building `no-throw` unnecessary?

**Linked asset for:** GitHub issue #2 (research ticket on the `no-throw` wayfinder map, #1).

**Lens used throughout:** the thing we care about is the **call-graph guarantee** — does a tool enforce, transitively, that a function marked/known non-throwing may only call non-throwing functions (with `try/catch` as the sanctioned bridge)? — versus a mere **value type** at a single call site (like `Result<T,E>`) that a caller can freely ignore or unwrap. Where a claim comes from a secondary source it is marked *(secondary)*; everything else is a primary source (official docs, source code, first-party issue threads).

---

## Table of prior art

| Prior art | What it does | Call-graph guarantee? | How close to our destination | Reusable for `no-throw`? |
|---|---|---|---|---|
| **eslint-plugin-functional › `no-throw-statements`** | Bans the `throw` keyword outright ("This rule disallows the `throw` keyword"). Option `allowToRejectPromises`. Its other rules enforce immutability / no side-effects, not exceptions. [src](https://github.com/eslint-functional/eslint-plugin-functional/blob/main/docs/rules/no-throw-statements.md) | **No.** Pure syntactic ban at the `throw` site; no notion of callees or propagation. | Blunt: forbids all throwing rather than *coloring* functions. No opt-in, no bridge, no transitivity. | Concept-adjacent only. Not reusable as-is. |
| **eslint-plugin-total-functions** | Enforces *type-level totality*: bans unsafe type assertions, readonly↔mutable assignment, `enum`, partial `division`/`URL`/`normalize`/`reduce`, requires `noUncheckedIndexedAccess`. [src](https://github.com/danielnixon/eslint-plugin-total-functions) | **No** (and not about exceptions at all). | Different problem (soundness of *values/types*), despite the "total functions" name. Does **not** analyze `throw`/exceptions. | Not relevant. |
| **eslint-plugin-etc › `throw-error`** | "Forbids throwing — or rejecting with — non-`Error` values." Rest of the plugin is grab-bag TS hygiene (`no-deprecated`, `no-misused-generics`, …). [src](https://github.com/cartant/eslint-plugin-etc) | **No.** Only constrains *what* you throw, not *whether/where*. | Far. | Not relevant. |
| **@typescript-eslint › `only-throw-error`** (and core ESLint `no-throw-literal`) | Disallows throwing non-`Error` values. [docs](https://typescript-eslint.io/rules/only-throw-error/) | **No.** No `throws`/exception-safety rule exists; no checked-exceptions proposal in their tracker. | Far. | Reuse their *type-checked rule scaffolding* (typescript-eslint) as the build substrate, not the semantics. |
| **eslint-plugin-exception-handling** (Akronae) — rules `no-unhandled`, `might-throw` | Statically infers whether a call "might throw" by scanning the function body **and its callees transitively**; a call inside a `try` is treated as handled; `no-unhandled` reports a throwing call only when there is no enclosing named function to propagate to (i.e. unhandled at top of stack). [src](https://github.com/Akronae/eslint-plugin-exception-handling) · [analyzer source](https://github.com/Akronae/eslint-plugin-exception-handling/blob/main/src/utils/can-func-throw.ts) | **Partial / de-facto, by inference.** It *does* walk the call graph transitively — the single closest existing thing — but there is no explicit "non-throwing" contract; it infers throw-ness for everything. | **Closest ESLint near-miss.** Same layer (ESLint), same `try/catch` bridge, real transitive analysis. But the model is *inverted*: inference-first "flag anything unhandled," no opt-in coloring, no incremental-adoption story, and it is **unsound at boundaries** (skips `node_modules`, assumes library calls don't throw unless on a hardcoded native list; hand-rolled cross-file resolution). | Strong reference implementation / prior art to study and cite; **not** a drop-in. Different default and no enforced non-throwing boundary. |
| **eslint-plugin-neverthrow › `must-use-result`** | Forces a `Result` value to be consumed via `.match` / `.unwrapOr` / `._unsafeUnwrap` — "a porting of Rust's `must-use`." [src](https://github.com/supermacro/neverthrow) | **No.** Enforces *local* consumption of one value; nothing about callers being Result-based. | Enforces handling at one site, not a call-graph color. | Not reusable for the coloring guarantee. |
| **Effect (Effect-TS) — `Effect<A, E, R>`** | Error channel `E` is part of the type; composing effects **unions** the error types transitively ("if a program can fail with multiple types of errors, they are automatically tracked as a union"). [docs](https://effect.website/docs/error-management/expected-errors/) | **Yes — but only *within Effect-world*.** The guarantee holds for code already lifted into the `Effect` monad. | Conceptually the destination (transitive, typed, enforced) — but reached by rewriting code into a monad (`Effect.gen`, `yield*`, `pipe`). | Not reusable: the *cost* (whole-codebase monadic rewrite) is exactly the footprint `no-throw` exists to avoid. Useful as proof the transitive model is sound. |
| **neverthrow / true-myth / fp-ts** — `Result<T,E>` / `Either` | Provide a two-branch value type (`Ok`/`Err`, `Right`/`Left`). [neverthrow](https://github.com/supermacro/neverthrow) · [true-myth](https://github.com/true-myth/true-myth) · [fp-ts Either](https://gcanti.github.io/fp-ts/modules/Either.ts.html) | **No.** Value type at a single site; a caller can ignore/unwrap it. fp-ts: "the library offers no mechanism to require developers to use it or to track which functions might fail." | Only the single-call-site half; no propagation enforcement. | Out of scope by design — `no-throw` deliberately leaves the *error value* representation to the function (these are candidates the user might pick). |
| **Java — checked exceptions (`throws`)** | Canonical call-graph-*enforced* checked exceptions: a method must either `catch` or declare `throws` for each checked type; compiler enforces transitively. | **Yes** (language-level, typed + checked). | The reference design for the guarantee — but typed *and* mandatory. | Not reusable (language feature) and carries the well-known backlash (see constraints). |
| **Swift — `throws` / `rethrows` / typed `throws(E)`** | A function must be marked `throws` to propagate; callers must write `try`; "Only throwing functions can propagate errors. Any errors thrown inside a nonthrowing function must be handled inside the function." `rethrows` propagates only errors from closure params. Typed throws `throws(E)` shipped in **Swift 6.0** (SE-0413). [guide](https://github.com/swiftlang/swift-book/blob/main/TSPL.docc/LanguageGuide/ErrorHandling.md) · [SE-0413](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0413-typed-throws.md) | **Yes** (language-level). Note: untyped `throws` alone is *exactly* our binary coloring — non-throwing is the default, throwing is opt-in via `throws`, and the compiler enforces the call-graph rule with `do/catch` as the bridge. | **The single best conceptual match** for `no-throw`'s core (binary color, non-throwing default, enforced propagation) — Swift just does it in the compiler and reverses the default. | Not reusable directly, but the strongest design precedent that the *untyped, binary* version is coherent and shippable. |
| **Zig — error unions `!T`, `try`, `errdefer`** | Return type `ErrorSet!T` encodes fallibility; you cannot ignore an error union — must `try` (propagate), `catch` (handle), or unwrap. [docs](https://ziglang.org/documentation/master/#Errors) | **Yes** (language-level, via return type). | Another language-level proof of the enforced-propagation model, typed via error sets. | Not reusable (language feature). |
| **Flow** | Type checker; catch-variable annotations must be `mixed`/`any`; no `throws` in function types. [issue #2470](https://github.com/facebook/flow/issues/2470) | **No.** Flow never tracked exceptions in the type; long-standing gap. *(near-primary: maintainer issue thread)* | Confirms the "not in the type" status quo for a sibling type-checker. | Not relevant beyond confirming no one solved it at the JS type layer. |
| **TypeScript `throws`-in-the-type proposals** — #13219 (Declined), #56365 (discussion hub), #57943 ("Pragmatic, Not-Really-Typed Errors", In Discussion) | Repeated requests for a `throws` clause + typed `catch`; #13219 closed **not planned / Declined** after a definitive maintainer write-up. [#13219](https://github.com/microsoft/TypeScript/issues/13219) · [#56365](https://github.com/microsoft/TypeScript/issues/56365) · [#57943](https://github.com/microsoft/TypeScript/issues/57943) | **No** — rejected precisely *because* making it a sound type-level guarantee is intractable in JS (see constraints). | Defines the wall `no-throw` must not run into. | The rejection is the reason `no-throw` is a **lint rule, not a type**. |

---

## Headline verdict

**No existing tool makes `no-throw` unnecessary.** Nothing on the market delivers all of: *colors ordinary TS functions throwing/non-throwing · enforces the transitive call-graph rule · with `try/catch` as the only bridge · non-throwing opt-in for incremental adoption · at zero/low footprint on plain TS.* The near-misses each fall short on a specific axis:

- **eslint-plugin-exception-handling** (the closest) is in the right layer (ESLint) with real transitive call-graph analysis and `try` as the handled-boundary — but its model is *inverted*. It **infers** throw-ness for everything and flags whatever is unhandled at the top of the stack; there is **no opt-in "this function is non-throwing" contract to enforce**, so it has no incremental-adoption path and floods a legacy codebase. It is also **unsound at boundaries** (its analyzer skips `node_modules` and assumes third-party calls don't throw unless hardcoded), whereas `no-throw`'s "throwing is the default color" makes the *sound* assumption (unknown ⇒ throwing). Study it as prior art; don't adopt it as the solution.
- **Effect** achieves the transitive, enforced guarantee — but only *inside* the Effect monad, i.e. after rewriting your code into `Effect<A,E,R>`. That whole-codebase footprint is exactly what `no-throw` is designed to avoid.
- **Result-type libraries** (neverthrow, true-myth, fp-ts) give only the *value type at one site*; a caller can ignore or `_unsafeUnwrap` it. They are candidates for how a non-throwing function *represents* its error — which `no-throw` explicitly leaves out of scope — not a call-graph guarantee.
- **Java / Swift / Zig** prove the enforced-propagation model works, but only as **language/compiler** features. Swift's *untyped* `throws` is the cleanest conceptual match (binary color, enforced propagation, `catch` bridge); it just lives in the compiler and defaults the opposite way.
- The **TypeScript `throws` proposals were rejected**, which is the whole reason to build `no-throw` as an out-of-band lint rule rather than lobbying for a type-system feature.

Net: build `no-throw`. Its differentiator — an *opt-in binary coloring enforced across the call graph by a lint rule on ordinary TS, with `try/catch` as the sanctioned bridge* — is unoccupied.

---

## Hard constraints to inherit

### 1. The standing TypeScript-team objection to `throws`-in-the-type (the load-bearing constraint)

Issue **#13219 "Suggestion: `throws` clause and typed catch clause"** was closed **not planned / Declined** with a long design rationale from **Ryan Cavanaugh (RyanCavanaugh)**, [`issuecomment-1515037604`](https://github.com/microsoft/TypeScript/issues/13219#issuecomment-1515037604). The core objections, verbatim:

> "After reviewing all the comments here over the years and much discussion internally, we don't think that the JavaScript runtime or overall ecosystem provide a platform on which to build this feature in a way that would meet user expectations."

The **default-throw-state dilemma** (why any typed version is dead on arrival) — both horns fail:

> "If we assume all unannotated functions don't throw, the feature largely does not work until every type definition in the program has accurate `throw` clauses … If we assume all unannotated functions do throw, the feature largely does not work until every type definition in the program has accurate `throw` clauses"

On **soundness in practice**:

> "Anything more inferential than that is unlikely to be sound in practice."

And on **checked exceptions specifically**:

> "Beyond Java and Swift, though, no other mainstream programming language has adopted this feature. The common opinion among language designers, including ourselves, is that this is largely an anti-feature in most cases."

**How `no-throw` must design around it (each sub-objection is dodged deliberately):**
- **Don't put it in the type.** `no-throw` is a *lint rule*, not a `.d.ts`-level type feature — it never asks the ecosystem to annotate `throws` in declaration files (the "huge amount of new information in .d.ts that isn't documented" problem Cavanaugh's TL;DR names).
- **Default to throwing** — the *sound* horn of the dilemma. Unannotated / third-party / unknown code is assumed *throwing*, so `no-throw` never emits a false "won't throw" guarantee (the exact failure mode Cavanaugh flags for the "assume don't throw" default).
- **Binary, not typed.** `no-throw` tracks a single color and leaves *which* error / how it's represented out of scope — sidestepping the typed-exception information explosion and the avoidable/unavoidable-error classification he calls unresolvable in JS.
- **Opt-in.** Non-throwing is opt-in, so there is no "doesn't work until the whole program is annotated" precondition — it works locally from the first annotated function outward.

*(Continuation venues if the maintainer stance ever moves: [#56365](https://github.com/microsoft/TypeScript/issues/56365) discussion hub, and the newer, still-open [#57943 "A Pragmatic, Not-Really-Typed Errors Proposal"](https://github.com/microsoft/TypeScript/issues/57943) — worth watching but not a solution today.)*

### 2. The Java checked-exceptions backlash

From Anders Hejlsberg's interview **"The Trouble with Checked Exceptions"** [artima](https://www.artima.com/articles/the-trouble-with-checked-exceptions) *(primary: his own words in a published interview)* — the two failure modes to avoid:

- **Versioning / scalability:** adding a thrown type is a breaking change and `throws` clauses "balloon out of control" up the aggregation ladder.
- **Swallowing:** developers defeat the checker with empty `catch` blocks ("catch curly curly"), so "checked exceptions have actually degraded the quality of the system in the large."

**Design implications for `no-throw`:** (a) never force exhaustive *per-error-type* declarations — the binary color + "error value out of scope" choice already avoids the ballooning-`throws`-clause problem; (b) be aware the sanctioned bridge (a `try/catch` that *converts* the throw to a returned value and does **not** re-throw) can still be gamed by an empty/swallowing catch — the rule's value depends on the catch actually handling, and any "just make the linter shut up" escape hatch reintroduces Hejlsberg's swallowing failure.

### 3. The Effect-monad rewrite cost

Effect delivers the real transitive guarantee but only after code is rewritten into `Effect<A,E,R>` ([docs](https://effect.website/docs/error-management/expected-errors/)). That footprint is the anti-goal: `no-throw`'s reason to exist is to give a comparable call-graph guarantee on **ordinary, un-rewritten TS** with an incremental opt-in.

### 4. Boundary soundness (learned from eslint-plugin-exception-handling)

Its analyzer resolves callees by re-reading files and **treats `node_modules` and un-resolvable calls as non-throwing** ([`can-func-throw.ts`](https://github.com/Akronae/eslint-plugin-exception-handling/blob/main/src/utils/can-func-throw.ts)). That is the unsound direction. `no-throw`'s throwing-by-default color inverts this: anything it cannot prove non-throwing is treated as throwing, so a non-throwing function that calls unknown code is (correctly) rejected rather than waved through.

---

## Sources

- TypeScript #13219 — Suggestion: `throws` clause and typed catch clause (Declined): https://github.com/microsoft/TypeScript/issues/13219
- Ryan Cavanaugh's rationale comment (`issuecomment-1515037604`): https://github.com/microsoft/TypeScript/issues/13219#issuecomment-1515037604
- TypeScript #56365 — exceptions discussion hub: https://github.com/microsoft/TypeScript/issues/56365
- TypeScript #57943 — A Pragmatic, Not-Really-Typed Errors Proposal (In Discussion): https://github.com/microsoft/TypeScript/issues/57943
- eslint-plugin-functional — `no-throw-statements` rule doc: https://github.com/eslint-functional/eslint-plugin-functional/blob/main/docs/rules/no-throw-statements.md
- eslint-plugin-total-functions: https://github.com/danielnixon/eslint-plugin-total-functions
- eslint-plugin-etc: https://github.com/cartant/eslint-plugin-etc
- @typescript-eslint — `only-throw-error`: https://typescript-eslint.io/rules/only-throw-error/
- eslint-plugin-exception-handling (Akronae): https://github.com/Akronae/eslint-plugin-exception-handling
- eslint-plugin-exception-handling — analyzer source `can-func-throw.ts`: https://github.com/Akronae/eslint-plugin-exception-handling/blob/main/src/utils/can-func-throw.ts
- eslint-plugin-exception-handling — `no-unhandled` rule source: https://github.com/Akronae/eslint-plugin-exception-handling/blob/main/src/rules/no-unhandled/no-unhandled.ts
- neverthrow (Result + eslint-plugin-neverthrow `must-use-result`): https://github.com/supermacro/neverthrow
- true-myth: https://github.com/true-myth/true-myth
- fp-ts — Either module: https://gcanti.github.io/fp-ts/modules/Either.ts.html
- Effect — expected errors / error channel: https://effect.website/docs/error-management/expected-errors/
- Swift — Error Handling language guide: https://github.com/swiftlang/swift-book/blob/main/TSPL.docc/LanguageGuide/ErrorHandling.md
- Swift Evolution SE-0413 — Typed throws (Implemented, Swift 6.0): https://github.com/swiftlang/swift-evolution/blob/main/proposals/0413-typed-throws.md
- Zig — Errors / error unions: https://ziglang.org/documentation/master/#Errors
- Flow #2470 — doesn't check the type of an exception: https://github.com/facebook/flow/issues/2470
- Anders Hejlsberg, "The Trouble with Checked Exceptions" (interview): https://www.artima.com/articles/the-trouble-with-checked-exceptions

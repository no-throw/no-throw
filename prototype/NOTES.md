# Findings — spike #6

**Verdict: the mechanism holds together.** A real typescript-eslint rule, reusing
the host `ts.Program`, correctly colors and enforces all four load-bearing cases.
Nothing in the core mechanism felt wrong. The value of the spike was the **edge
cases it surfaced** — which sharpen the spec and graduate fog.

## What held together (validated)

1. **Cross-file color read via the `@nothrow` carrier ([#5](https://github.com/MidnightDesign/no-throw/issues/5)).** Resolving a callee's
   symbol through the checker (following import aliases) and reading `@nothrow`
   off its JSDoc works cleanly across a file boundary — for *in-source* `.ts`
   in one program. (The `.d.ts`/`removeComments` stripping [#3](https://github.com/MidnightDesign/no-throw/issues/3) flagged is a
   *cross-package* concern; the manifest, not the tag, is the transport there.)
2. **The `try/catch` bridge** — a lexical ancestor walk (call inside a try-block
   that has a catch, not crossing a function boundary) cleanly separates bridged
   from unbridged calls.
3. **The opaque floor is sound ([#4](https://github.com/MidnightDesign/no-throw/issues/4)).** `JSON.parse` resolves to a bodyless
   `lib.es5.d.ts` signature ⇒ throwing, with no special-casing. Any external /
   `any` / dynamic callee falls to the same floor.
4. **Hybrid inference ([#4](https://github.com/MidnightDesign/no-throw/issues/4)) works and is load-bearing.** Unmarked `double` is
   *inferred* non-throwing (so `safe.ts` needs no bridge to call it); unmarked
   `mustBePositive` is inferred throwing. Memoized; mutual recursion between the
   engine and `resolveColor` propagates color transitively.
5. **Core + thin adapters ([#10](https://github.com/MidnightDesign/no-throw/issues/10)) is real.** The exact same engine drives the
   ESLint rule *and* a standalone `ts.Program`. The ESLint adapter is ~30 lines.

## What surfaced (feeds the spec / graduates fog)

These are the "what felt wrong / what edge cases surfaced" the ticket asked for.
None break the core; all are **holes the spec must decide explicitly**.

1. **Bridge soundness is under-specified.** "Any `try` with a `catch` = bridged"
   is optimistic. It wrongly accepts a `catch` that **rethrows** (`catch (e) {
   throw e }`) and doesn't reason about throws in the **`catch`/`finally`**
   blocks themselves. The spec must pin *what makes a catch a valid bridge* —
   [#5](https://github.com/MidnightDesign/no-throw/issues/5) already says the catch must "convert the throw into a returned value
   and not re-throw"; the spike shows that clause needs teeth (no-rethrow check).
2. **Mark attachment point is unspecified for non-declarations.** Only
   `function` declarations were fixtured. For `const f = () => …`, object
   methods, and class methods, JSDoc attaches to the *variable statement /
   property*, not the function node — `getJSDocTags` on the arrow may miss it.
   The carrier needs a precise "where does `@nothrow` bind" rule.
3. **Inference fixpoint policy is a real choice.** Cycles use an *optimistic*
   fixpoint (recursion ⇒ non-throwing until proven otherwise). Untested here;
   a mutually-recursive throwing pair could be mis-inferred. Spec must state it.
4. **Async is genuinely separate.** Everything here is sync. An awaited rejection
   is a throw the rule must see, and [#3](https://github.com/MidnightDesign/no-throw/issues/3) noted TS models no rejection type.
   This spike is evidence that [#12](https://github.com/MidnightDesign/no-throw/issues/12) (async story) is a distinct, needed decision.
5. **The manifest boundary was NOT exercised.** All fixtures share one program,
   so only the *in-source* half of [#5](https://github.com/MidnightDesign/no-throw/issues/5) (JSDoc authoring) was proven. The
   *cross-package* transport (emitted JSON manifest + `@nothrow/*` overlay,
   read from an opaque `.d.ts`-only dep) still needs its own concrete exercise.
6. **Perf was not measured.** 5 tiny files; the ~50 ms/2000-fn figure ([#3](https://github.com/MidnightDesign/no-throw/issues/3)) —
   the number the [#4](https://github.com/MidnightDesign/no-throw/issues/4) rip-out lever hangs on — is untested at scale here.

## Implication for the map

- **De-risked:** the color/enforcement core, the JSDoc carrier (in-source), the
  opaque floor, hybrid inference, and the thin-adapter architecture. Safe to spec.
- **Sharpened (throwing-surface fog):** bridge soundness (rethrow / finally),
  mark attachment on non-declarations, inference fixpoint — now concrete enough
  to pin in a dedicated decision.
- **Confirmed separate:** async ([#12](https://github.com/MidnightDesign/no-throw/issues/12)); the manifest/boundary transport (still fog,
  now clearly needing its *own* concrete exercise, not covered by this spike).

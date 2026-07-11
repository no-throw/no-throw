# Findings — spike #15 (manifest across a package boundary)

**Verdict: the transport works.** Colors and the `async` (sync-safe) flag crossed
a real package boundary — producer compiled to `.d.ts` + `.js` with comments
stripped, "published" into the consumer's `node_modules`, consumer running its
own separate `ts.Program` — and every verdict in all three report configurations
matched expectations on the first full run. The #6 spike's report and lint still
pass unchanged on the extended engine.

## What held together (validated)

1. **The manifest carries color where the tag cannot.** The emitted
   `dist/index.d.ts` provably contains no `@nothrow` (removeComments) and no
   `async` keyword (declaration erasure) — the report prints it as evidence.
   The consumer still resolves the right colors: decl in the dep's `.d.ts` →
   walk up to `package.json` → `"nothrow"` discovery field → manifest entry.
2. **The `async` flag is load-bearing — exactly as [#12](https://github.com/MidnightDesign/no-throw/issues/12) predicted.**
   `fireAndForget` (`fetchFlaky().catch(() => {})`) is PASS with the flag and
   flips to FAIL in the counterfactual run that ignores it. The `.d.ts` surface
   (`(): Promise<string>`) can never license the `.catch` bridge on its own.
3. **Absence degrades safely, never unsoundly.** The no-manifest control run
   floors every dep call to throwing: `handleConfig`/`greet` go FAIL (annoying,
   safe), nothing goes PASS that shouldn't.
4. **Trust-by-construction works mechanically ([#5](https://github.com/MidnightDesign/no-throw/issues/5)).**
   The lying `badMark` (`@nothrow` + uncaught throw) is *refused* at emit; the
   consumer floors it. The one unsound surface stayed contained with no hashing
   built yet.
5. **The seam held ([#4](https://github.com/MidnightDesign/no-throw/issues/4)/[#10](https://github.com/MidnightDesign/no-throw/issues/10)).**
   Manifest lookup enters the engine as an injected `opts.resolveOpaque` on the
   same color-resolution seam inference sits behind; the engine stays fs-free,
   and the #6 rule + report run unchanged (backward-compatible extension).
6. **The minimal [#12](https://github.com/MidnightDesign/no-throw/issues/12) async rules behaved**:
   `try { await … } catch` bridges; `try { f() } catch` *without* `await` falls
   out naturally as a Tier-1 float escape (the fake-bridge trap needs no special
   case); statement-position floats of throwing async calls are escapes.

## Schema discovery (the point of the spike)

**The manifest is *not* just "the verified non-throwing exports."** A *throwing*
entry earns its place by carrying the sync-safe witness alone:

```json
{ "fetchFlaky": { "color": "throwing", "async": true } }
```

— the `fetch` shape. So an entry asserts two independent facts, `color` and
`async`, and the emit rule is: marked + verified ⇒ `non-throwing`; unmarked but
visibly `async` ⇒ `throwing, async: true` (the async keyword is a
compiler-checked fact, so this stays trust-by-construction). Unmarked sync ⇒
absent (the floor covers it).

## What surfaced (feeds the schema/governance design)

1. **Keying is the real schema problem.** The spike keys by bare top-level
   export name off `decl.name` — the degenerate case. It already cannot see:
   renamed re-exports (`export { a as b }`), default exports, `const f = () =>`
   exports (no `FunctionDeclaration` — both the emit walk and the reader miss
   them), class/interface methods (`Type#method`), overloads (`name#index`),
   export subpaths. Confirms the fog's "key by subpath + symbol, never internal
   file paths" as necessary, not aesthetic.
2. **The resolver is on a hot path.** Every opaque decl asks it — including
   every `lib.es5.d.ts` hit (`JSON.parse` etc.), constantly. The per-directory
   cache mattered even at spike scale; the walk-up must stop at the first
   `package.json` (package boundary), which also naturally handles nested
   `node_modules`.
3. **`.catch` itself resolves to lib `Promise.catch` (bodyless ⇒ floor).** The
   engine must recognize the `.catch`-bridge shape *before* generic call
   handling or the bridge itself gets flagged as a bare throwing call. Worth a
   line in the spec's fold-table notes.
4. **Carrier precedence when JSDoc survives.** With `removeComments: false` the
   `@nothrow` tag would survive into the `.d.ts` and `isMarked` would trust it —
   two carriers that can disagree (stale tag vs manifest). The spike sidesteps
   it by stripping; the schema ticket must pin precedence (per #5 the manifest
   is the cross-package authority).
5. **Staleness is untested.** Fail-safe was only shown for *absence*. Editing
   `dist/` without re-emitting (drift) is exactly what #5's content-hashing is
   for — deliberately left to the schema design, not spiked.
6. **Overlay & precedence compose at the seam.** `@nothrow/*` overlays and
   local overrides weren't exercised, but the shape is visible: they're just
   more `resolveOpaque` sources, so precedence (local > overlay > shipped) is
   resolver composition — an ordered chain behind the same seam.
7. **Wider async dataflow stays floored.** Only direct-call `await` and
   direct-chain `.catch` were implemented, per #12's v1 rule; call-initialized
   `const` awaits and friends were not fixtured here.

## Implication for the map

- **De-risked:** the emit → publish → discover → resolve pipeline end-to-end;
  async-flag carriage and its load-bearingness; fail-safe degradation;
  trust-by-construction refusal at emit.
- **Graduates:** the "manifest / overlay wire-format & ergonomics" fog is now
  concrete enough to design against — schema keying (subpaths, renames,
  methods, overloads, const-arrows), `version`/hash fields, the discovery-field
  name, precedence order (local > overlay > shipped > surviving-JSDoc?),
  re-verify-vs-trust policy when source is present, and registry governance
  (neutral `@nothrow/*` + published JSON Schema).

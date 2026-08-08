# Spike (#81): the engine on the TypeScript 7 API

**Question:** can the engine run on the TypeScript 7 API, and what does the
per-node-pull architecture cost once the checker is out of process?

**Answer:** yes, it runs — the real `@nothrow/core` produces identical findings
on 161 of 180 conformance fixtures driven by a TypeScript 7 client. But the
architectural premise the ticket was filed on does not survive measurement.

The restructure [#81][] called "the real work" — moving the engine from per-node
pull to per-pass batch — was built, measured, and **removed**. It buys 1.0x in
request count on real code and made a TypeScript 7 run **2.3x slower**, because
prefetching a frontier over-fetches roughly four nodes for every one the engine
turns out to want. Only two of the port's thirty operations have a bulk form at
all, and they are ~21% of what the engine asks, so no prefetch could have paid.

What does decide the bill is **port granularity**. Two operations that asked the
type system to enumerate a symbol table and then filtered client-side accounted
for 99% of every type question the engine made. Fixing those — one interface
change and one laziness fix — cut a dogfooding run from **29,414 type queries to
309**, and a mark-dense project from **112,420 to 13,220**.

The measured verdict on TypeScript 7 is a **crossover, not a win or a loss**:
tsgo builds the program ~9x faster and answers the engine's questions ~7x
slower, so it is ahead on mark-sparse projects and behind on mark-dense ones,
crossing at roughly **200 marks per project**.

Everything here is measured on this machine (Windows 11, Node 22.12) against
`@typescript/native-preview@7.0.0-dev.20260707.2`. Reproduction commands are in
[README.md](README.md).

[#81]: https://github.com/MidnightDesign/no-throw/issues/81

---

## 1. The deep-chain anomaly does not exist

The ticket named this first and said it "dominates every other number in this
document" if real: a fixture of 500 functions in a transitive call chain took
35.7 s to load and showed 51.3 ms per request, against 154 ms and 0.20 ms/request
for 500 independent functions.

**It did not reproduce, under any shape.** The original fixture was not
preserved, so this rebuilt every shape a "f0 ← f1 ← … ← f499" generator could
plausibly have produced:

| shape (n=500) | load | unbatched | ms/req | server | batched |
|---|---:|---:|---:|---:|---:|
| independent, one file | 44 ms | 41 ms | 0.08 | 5 ms | 2 ms |
| transitive chain, annotated | 40 ms | 39 ms | 0.08 | 5 ms | 2 ms |
| transitive chain, inferred returns | 38 ms | 39 ms | 0.08 | 9 ms | 3 ms |
| chain declared top-down, inferred | 41 ms | 32 ms | 0.06 | 6 ms | 2 ms |
| 500-deep lexical nesting | 45 ms | 97 ms | 0.19 | 58 ms | 2 ms |
| one 500-deep call expression | 40 ms | 26 ms | 0.05 | 6 ms | 2 ms |
| mutual recursion (the SCC shape) | 43 ms | 28 ms | 0.06 | 2 ms | 1 ms |
| widening chain | 38 ms | 26 ms | 0.05 | 3 ms | 2 ms |
| generic instantiation chain | 45 ms | 27 ms | 0.05 | 5 ms | 2 ms |
| one file per function, chained | 66 ms | — | — | — | — |

Scaling the chain 16x past where the anomaly was reported stays linear, and load
stays flat:

| n | load | walk | unbatched | ms/req | batched |
|---:|---:|---:|---:|---:|---:|
| 100 | 38 ms | 2 ms | 9 ms | 0.09 | 1 ms |
| 500 | 52 ms | 6 ms | 27 ms | 0.05 | 2 ms |
| 1000 | 39 ms | 5 ms | 50 ms | 0.05 | 4 ms |
| 2000 | 40 ms | 6 ms | 86 ms | 0.04 | 10 ms |
| 4000 | 45 ms | 12 ms | 165 ms | 0.04 | 9 ms |
| 8000 | 47 ms | 24 ms | 335 ms | 0.04 | 20 ms |

Three further hypotheses were tested and refuted: **cold start** (a first
instantiation in a fresh process loads in 40 ms), **an intermittent stall**
(12 fresh API instances: load min 38 / median 40 / max 45 ms; no outliers), and
**an unscoped `tsconfig`** — the one fixture-generator mistake that could plausibly
turn a 500-function project into a 1,898-file one. Even that costs 168 ms, not
35 s.

**The original numbers contain the proof themselves.** That run reported a local
AST walk of 1,105 ms where the independent-function fixture of the same size
took 20.5 ms — a 54x slowdown in the one phase that issues **zero requests** and
never touches the checker. Whatever was slow that day was slowing down plain
client-side recursion, so it cannot have been a checker pathology, whatever the
fixture looked like.

**Conclusion:** environmental. Transport settles at 0.04–0.09 ms per round trip
across every shape and size, *better* than the 0.20 ms the research note
recorded. Nothing about the fixpoint's shape provokes the checker. The rest of
this document's numbers can be trusted.

## 2. The API surface, checked rather than listed

The research note checked seven checker methods off a hand-written list. This
walks what `@nothrow/core` actually calls — checker methods, the members it
reads off `Type`/`Symbol`/`Signature` objects, and the `ts.*` module helpers —
and exercises each against a fixture rather than reading the `.d.ts`.

**Present and working (18):** `getTypeAtLocation`, `getSymbolAtLocation`,
`getApparentType`, `getPropertyOfType`, `getPropertiesOfType`, `getTypeOfSymbol`,
`getTypeOfSymbolAtLocation`, `getResolvedSignature`, `getDeclaredTypeOfSymbol`,
`getBaseConstraintOfType`, `getBaseTypes`, `getTypeArguments`,
`getExportsOfModule`, `getAliasedSymbol`, `typeToString`, plus the object-side
reads TypeScript answers as members and tsgo answers on the checker
(`type.getCallSignatures()` → `getSignaturesOfType`, `signature.getReturnType()`
→ `getReturnTypeOfSignature`) and the carrier's `getJsDocTagsOfSymbol`.

**Genuinely missing (3):**

| engine call | tsgo | consequence, measured |
|---|---|---|
| `getAwaitedType` | absent | one fixture reports an **extra** finding — over-strict, the sound direction |
| `getPropertySymbolOfDestructuringAssignment` | absent | one fixture **loses two** findings — the unsound direction |
| `getIndexTypeOfType` (+ `IndexKind`) | replaced by `getIndexInfosOfType` | offline baseline tooling only, not the engine |

The first two are the *only* behavioral differences between the two backends
across the whole conformance corpus (§5). They are worth reporting upstream
while the 7.1 surface is still being curated: both are questions a type-aware
linter asks, and the second one loses soundness rather than precision.

**Shimmable (7):** `canHaveDecorators`, `canHaveModifiers`, `getDecorators`,
`getModifiers`, `getCombinedModifierFlags`, `getCombinedNodeFlags`,
`getNameOfDeclaration` are absent, but every node member they read
(`modifiers`, `name`, `flags`, `parent`, `jsDoc`) is present, so each is a few
lines. `SymbolFlags` and `TypeFlags` are not missing — they live on
`unstable/sync` rather than `unstable/ast`.

**Predicates:** tsgo exports 352 per-kind predicates. Of the 57 the engine uses,
**52 match by name**. The five that differ are `isClassLike`, `isFunctionLike`,
`isMethodSignature`, `isParameter` and `isPropertySignature`, all with obvious
counterparts — though `isFunctionLike` is a *widening*, not a rename: TypeScript's
admits bodyless signatures and tsgo's `isFunctionLikeDeclaration` does not.

## 3. Where the seam actually falls

The measurements decide this, and they contradict the plan.

**Syntax does not cross the wire.** A full recursive walk reports `requests=0`
after `getSourceFile`; `node.parent` works; every member name the engine reads
matches. So there is nothing to hide behind a port and nothing to batch. The
syntax layer is handled by *substituting the module* — which is what
[`tsgo/typescript-shim.mjs`](tsgo/typescript-shim.mjs) does, in about 120 lines,
to test the claim rather than assert it.

**Types are the opposite**, and that is where `TypeFacts` went, in
`packages/core/src/type-facts.ts`. Its refs are opaque on purpose: every
question about a type is a method on the port, *including* the ones TypeScript
answers as members like `type.isUnion()`, because a member read is exactly what
cannot cross a wire.

**One dependency is neither**, and it is the port's remaining hole: the export
surface walk reads a package's entry-point *files*, so `analyzeSourceFile` still
takes a `ts.Program`. Under tsgo there is no such object. §5 measures exactly
what that costs.

## 4. The batching restructure was built, measured, and removed

It was built as the ticket described: the engine walked the call graph
breadth-first from each seed and primed each frontier's type queries in one call
before resolving it, with the array overloads behind `TypeFacts.prime`. Tarjan
still ran depth-first; only *discovery* was breadth-first, which the free
syntactic walk makes possible. It was never load-bearing — every answer still
came from the memoized resolvers, so a missed frontier was slower and never
wrong.

**It made TypeScript 7 2.3x slower.** Same corpus, same commit, prefetch gated
on an environment variable:

| corpus | with prefetch | without |
|---|---:|---:|
| 20 files × 10 marks | 904, 883 ms | 401, 398 ms |
| 40 files × 10 marks | 1863, 1862 ms | 778, 780 ms |

Two reasons, and the second is the one that generalizes:

- **It over-fetches.** The prefetch covered 9,600 nodes to serve 2,620 actual
  queries — 73% waste. An array overload is one round trip, but the server still
  resolves every node in it and the response still carries every type.
- **It could not have paid even so.** Only `typeAt` and `symbolAt` have bulk
  forms, and they are ~21% of what the engine asks. A *perfect* prefetch of
  exactly the hit nodes still leaves ~79% of the queries one-at-a-time; the
  measured ceiling was 1.1x fewer requests.

So the restructure is gone, and with it `TypeFacts.prime`. The ticket's premise
that "the engine must move from per-node pull to per-pass batch" is **refuted**:
the pull is fine, and the 25x the research note measured came from a synthetic
fixture of 500 call sites in one body, which is not the shape of real work.

What the seam did buy is **visibility**, and that is what changed the answer.
Counting every port call over a real project
([`request-cost.mjs`](request-cost.mjs)):

| | queries, before | after | |
|---|---:|---:|---|
| `@nothrow/core` (38 files, 3 marks) | 29,414 | **309** | 95x |
| synthetic, 20 files × 10 marks | 112,420 | **13,220** | 8.5x |

Two causes, both "enumerate a symbol table, filter client-side" — the cheapest
possible operation in process and the most expensive over a wire:

1. **The well-known-symbol scan** (84% of the mark-dense run). TypeScript keys
   `[Symbol.iterator]` as `__@iterator@<id>` with an id that cannot be written
   down, so the engine fetched *every* property of a type and matched names —
   some forty per iteration site. The port now asks the question it means:
   `wellKnownMember(type, name)`. In process it is the same scan; over a wire it
   is one request instead of forty.

2. **The eager export-surface walk** (99% of the dogfooding run, all of it
   landing on the first file with a mark). The carrier computed each
   declaration's published key up front — walking the whole export surface of
   whichever package the declaration ships in — even though the three rungs that
   consume a key each check first whether they have a *table* for that package,
   which for almost every package they do not. `CarrierQuery.key` is now a
   question rather than a field, asked at most once per declaration and only by
   a rung with somewhere to look it up.

In-process wall clock moved with it, though it was never the constraint:
analysis of `@nothrow/core` went 86 ms → 24 ms.

**The projection model checks out.** 13,220 queries × 0.05 ms/request predicts
661 ms of transport for the 200-mark corpus; the measured tsgo analysis time is
442 ms, so the projection is conservative by about a third. Query count *is* the
cost out of process, which is why the port's granularity is the lever and the
traversal order is not.

## 5. Does the conformance suite pass on tsgo?

The suite drives ESLint, and ESLint's parser is TypeScript's own, so running the
*suite* on tsgo would measure typescript-eslint. What the engine owns is
`analyzeSourceFile`, so [`tsgo-conformance.mjs`](tsgo-conformance.mjs) points
both backends at that, over the suite's own fixture sources, and diffs the
findings. (Two processes: the TypeScript 7 backend works by resolving
`typescript` to the shim for everything under the engine, which is all-or-nothing.)

```
161 fixtures agree, 19 differ  |  errored: 0 on TypeScript 6, 18 on TypeScript 7
findings: 197 on TypeScript 6, 176 on TypeScript 7
```

The finding counts are there because two empty reports agree: a run that
analyzed nothing would otherwise claim total agreement, which an earlier version
of this harness did.

**18 of the 19 are one cause:** `the TypeScript 7 run reached ts.Program.getSourceFiles`.
Every one is a manifest, overlay or override fixture — precisely the fixtures
where a carrier rung *does* have a table, so the lazily-computed export key is
actually needed. This is §3's remaining hole, and it is now exactly
characterized: **one operation, "give me the source file at this path", is all
that stands between the engine and a program-free run.**

**The 19th is two real differences**, and each traces to one named missing
method:

- `destructuring-assignment-consults-get` — TypeScript 7 finds 1 of 3
  (`getPropertySymbolOfDestructuringAssignment`). **Unsound**: real escapes go
  unreported.
- `for-await-takes-producer-color` — TypeScript 7 finds an extra one
  (`getAwaitedType`, so an async iterator cannot be recognized and floors).
  **Over-strict**, which is the safe direction.

**One open discrepancy.** Dogfooding `@nothrow/core`, TypeScript 6 reports three
findings in `src/marks.ts` and TypeScript 7 reports none. It is not one of the
three API gaps — no missing operation was reached — and it is a *mark-binding*
difference, not a colour one: the two backends disagree about whether that file
contains a bound seed at all. The seed in question is bound off a JSDoc comment
whose prose mentions the tag, so the likeliest reading is that the two parsers
attribute JSDoc differently on that comment. Unresolved; no fixture covers it,
which is itself worth fixing.

## 6. Pricing a realistic project

Median of 3 runs, whole project, both phases separated —
[`wall-clock.mjs`](wall-clock.mjs):

| project | backend | files | findings | build | analysis | total |
|---|---|---:|---:|---:|---:|---:|
| `@nothrow/core` (3 marks) | TypeScript 6 | 38 | 3 | 408 ms | 24 ms | **432 ms** |
| `@nothrow/core` | TypeScript 7 | 38 | 0 | **47 ms** | 34 ms | **81 ms** |
| synthetic, 200 marks | TypeScript 6 | 21 | 200 | 421 ms | 69 ms | **490 ms** |
| synthetic, 200 marks | TypeScript 7 | 21 | 200 | **38 ms** | 442 ms | **480 ms** |
| synthetic, 600 marks | TypeScript 6 | 61 | 600 | 453 ms | 162 ms | **614 ms** |
| synthetic, 600 marks | TypeScript 7 | 61 | 600 | **43 ms** | 1344 ms | **1386 ms** |

Build is **~9x faster** on tsgo. Analysis is **~7x slower**, and linear in marks:
2.2 ms per mark against 0.3 ms in process, holding at both 200 and 600. The
build saving is roughly 380 ms, so the two cross at **~200 marks per project** —
the 200-mark row is a dead heat, and it is a dead heat for the right reason
rather than by luck.

This is what #10's reasoning looks like when the premise flips. #10 chose
in-process because no-throw is a guest paying ~50 ms marginal on a program the
host already built. Out of process the marginal cost is what grows, and the
thing that shrinks is the build we were not paying for anyway. **The escape
hatch #10 parked is the one this favours**: `nothrow emit` owns its program and
pays the full build, so it is the CLI, not the ESLint plugin, where a tsgo
backend pays for itself today.

The 200-mark corpus is synthetic; the ticket asked for a mid-size external
project and this does not have one. What it does have is the model that
predicted the synthetic result from query counts alone (§4), which is what makes
it extrapolable.

## 7. What pins us

`@typescript/native-preview` published **401 versions in 411 days** — one a day —
but the surface that matters is much younger and has not yet lost anything:

| version | `Checker` methods | vs. the pin |
|---|---:|---|
| 2026-03-20 | — | no `unstable/sync` Checker |
| 2026-04-21 | — | no `unstable/sync` Checker |
| 2026-05-01 | 43 | 23 added since, 0 dropped |
| 2026-05-15 | 43 | 23 added since, 0 dropped |
| 2026-06-07 | 44 | 22 added since, 0 dropped |
| 2026-07-07 (pin) | 66 | — |

So: the API appeared between 2026-04-21 and 2026-05-01, grew 43 → 66 methods in
ten weeks, and **removed nothing** across every sample. Purely additive so far.

One fact changes the pinning story: **the channel stopped publishing on
2026-07-07**, the day before TypeScript 7.0 shipped. `latest` is still the pinned
nightly and `beta` is older. A pin here is a pin to a *frozen* artifact, not a
moving one — which makes depending on it much safer than "a dated nightly"
suggests, and also means the surface will next move as the 7.1 API rather than
as another nightly.

What would make it safe to depend on:

- **Pin exactly** (`7.0.0-dev.20260707.2`, no range). The version is a date; a
  range over dates means nothing.
- **A conformance canary**, which §5 already is: the two-backend diff is a
  regression test on the API, not just on us. Run it against the pin and against
  `latest`; a new drop shows up as a fixture that stops agreeing, with the
  operation named. It has to be *stable* to be a gate, which took one fix: each
  backend runs its fixtures in chunks of twenty children deep, because a single
  child holding 180 whole TypeScript programs exhausts the heap and reports the
  survivors as disagreements. A dead child now marks its fixtures errored rather
  than passing them off as agreement.
- **Never on the enforcement path unpinned.** The `TypeFacts` seam means a
  broken backend is a swapped implementation, not a rewrite — which is the
  actual insurance, and it now exists.

## 8. The ESLint adapter

`libsyncrpc` blocks, and the whole of §5 is the proof: 180 fixtures analyzed
through the real engine, synchronously, with no promise anywhere on the path.
Nothing in the sync client would stop a synchronous ESLint rule from calling it.

But that is not the adapter's problem. ESLint gets its AST from
typescript-eslint's parser, which is TypeScript's; for the plugin to run on a
tsgo program, *the parser* must produce tsgo-parsed nodes. Mixing the two is not
a detail — it is the failure this spike hit twice: two TypeScript instances in
one process make every mark invisible (node objects carry instance-local JSDoc
caches), and a shim applied to the engine breaks the TypeScript 6 backend in the
same process.

**So the ESLint question is not ours to answer.** typescript-eslint pins
`typescript >=4.8.4 <6.1.0` and closed its TS7 support request as not planned.
Until that moves, the plugin's story is `@typescript/typescript6`, and #10's
guest reasoning holds unchanged for it. The CLI is where a tsgo backend is ours
to choose (§6).

## 9. What landed in `packages/core`

Not throwaway; conformance is green on all 180 fixtures and 7 CLI cases,
unchanged, at every step.

- **`type-facts.ts`** — the port: 30 operations named for what the engine wants
  to know, over opaque `TypeRef`/`SymbolRef`/`SignatureRef`.
- **`type-facts/typescript.ts`** — the in-process implementation. Every cast the
  opaque refs cost is in this one file, and so is every detail of how the
  compiler spells a well-known-symbol member.
- **`iteration.ts`, `transfers.ts`** — the well-known-member scan, replaced by
  two port questions (§4.1). `constituentsOf` renamed to
  `apparentConstituentsOf` there, since the port now owns the shorter name for
  the narrower operation.
- **`carrier/chain.ts`** — `CarrierQuery.key` made lazy (§4.2).
- **`analyze.ts`** — `analyzeSourceFile` takes an optional `TypeFacts`, which is
  how a non-TypeScript host, or an instrumented one, gets in.

The breadth-first discovery pass and `TypeFacts.prime` were built here too, and
removed again once measured (§4). Nothing of them is left.

## 10. What this graduates

1. **Close the port's last hole.** One operation — the source file at a path —
   stands between the engine and a program-free run, and it blocks 18 fixtures
   (§5). Small, well-defined, and it makes the tsgo backend complete.
2. **Report the two gaps upstream.** `getAwaitedType` and
   `getPropertySymbolOfDestructuringAssignment`, with the fixtures that show what
   each costs. The 7.1 surface is still being curated; the second one loses
   soundness.
3. **Explain the `marks.ts` divergence** (§5) and cover it with a fixture. Two
   parsers disagreeing about whether a comment carries a mark is a carrier
   question, not a performance one.
4. **Keep the query-count budget.** [`request-cost.mjs`](request-cost.mjs) turned
   two invisible 100x costs into numbers. In-process they were affordable, which
   is exactly why nobody found them. A gate on queries-per-mark would keep the
   next one from hiding.
5. **Re-price the CLI against the crossover.** §6 says tsgo wins below ~200
   marks and loses above, and `nothrow emit` is the surface that pays the build
   it would save. That is a product decision with a number attached now, and it
   is the one #10's parked escape hatch was waiting for.

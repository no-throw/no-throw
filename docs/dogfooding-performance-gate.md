# The performance release gate

`no-throw`'s design left exactly one performance risk live (#30, Further Notes):
the *cost* of hybrid inference at scale. #3 measured ~50 ms per 2,000 functions
for the transitive walk and #6 confirmed the memoized pass is real, but neither
ran against a large codebase — and #14 made the memo unit the **SCC**, so an
edit can split a cycle group or merge two, and invalidation has to dirty a whole
group. #30 §G makes pre-release dogfooding a **release gate**, and names the
remedy for failing it: pull #4's lever and ship pure declare, rather than make
inference cleverer.

This is that gate.

> **Recommendation: ship hybrid.** Inference costs **3.1 s of a 33 s CI lint**
> over 380,000 lines with 1,093 marks, and **~100 ms of an ~800 ms editor
> re-lint**. Eleven times the marks grows it by 7%, and the cycle-group edits
> #30 §G worried about cost no more than an ordinary body edit. Pulling #4's
> lever would buy back 8% of a lint run and give up every inferred color to do
> it.
>
> The decision is the owner's; sign-off is requested on #47. Two adoption
> defects found along the way are filed as #89 and #90 and are not part of this
> recommendation — #89 blocks installing the preset at all, and #90 is a
> soundness hole.

The harness is [`tools/dogfood`](../tools/dogfood/README.md); its raw output is
in [`tools/dogfood/results`](../tools/dogfood/results).

## The codebase

**microsoft/TypeScript**, at `b465fdbfe175304d9b977da137b2c178ae1091d3`.

| | |
| --- | --- |
| files in `src`, excluding `src/lib` | 601 |
| lines in `src`, excluding `src/lib` | 379,646 |
| files in `src/compiler` (the narrower scope) | 77 |
| lines in `src/compiler` | 192,636 |
| function declarations in `src` | 12,326 |
| call edges between them | 36,566 |
| typed lint in CI | yes — `parserOptions.project: ./src/tsconfig-eslint.json` over `src/**`, with `@typescript-eslint/no-unnecessary-type-assertion` on |
| toolchain | ESLint 10.1.0, typescript-eslint 8.57.2, TypeScript 6.0.2 |

Three reasons this is the right codebase for a *performance* gate, and two
honest limitations.

**It already pays for a program.** The comparison the gate needs is marginal —
what a typed-lint run costs before and after the rule is added — and that only
means anything where a typed-lint baseline already exists. TypeScript's CI
builds a program for `src/**` and runs a type-aware rule over it, so the program
build #3 measured is already sunk in the baseline arm.

**It is the pessimal case for inference, not a friendly one.** A floored callee
*truncates* the walk: nothing behind it is read. A codebase with a large
third-party surface is therefore the cheap case — its walk stops at the first
`.d.ts`. TypeScript's compiler is almost entirely first-party, so the walk stays
inside readable bodies and goes as deep as the call graph allows.

**Its call graph has the cycle structure the memo has to survive.** One SCC in
`src` has 1,189 members. If group-granular invalidation is ever expensive, it is
expensive there.

**Limitation 1 — the dependency surface is unrepresentatively small.**
`src/compiler` reaches `@types/node`, which #44 fixed as overlay-channel rather
than baseline material, so there is a real instance of the floor-noise question
here; but nothing like an ordinary application's dependency graph. What the
report says about *cost* is conservative for the reason above. What it says
about *floor noise* is a sample of one.

**Limitation 2 — it vendors its own copy of the standard library.**
`src/lib/*.d.ts` re-declares `Array`, `Math`, `Object` and the rest, and those
declarations merge with the real lib's. That changes which lib members the
baseline answers for — see *Adoption* — so the diagnostic counts below are
**not** a representative floor-noise sample, and are reported as counts rather
than as a rate anyone should generalize from. It does not affect the timings:
a floor is cheaper than a color, not dearer.

## What was measured

Both arms run the target's own ESLint, typescript-eslint and TypeScript, over
the same files, with the same ignore list. Only the rules change.

| arm | config |
| --- | --- |
| `baseline` | TypeScript's own `eslint.config.mjs`, untouched |
| `preset-compat` | that config plus `configs.recommended`, minus the preset's `@typescript-eslint` plugin registration |

The registration has to come out because the untouched preset **cannot be
loaded** into a config that already registers that plugin — the first finding
under *Adoption*. `preset-compat` keeps every rule the preset turns on,
including `@typescript-eslint/no-floating-promises`, resolved against the plugin
copy the base config already registered.

Each non-baseline arm runs twice: under the shipped `hybrid` policy, and under
`NOTHROW_COLOR_POLICY=declare` — #4's lever, which is the comparison this gate
exists to price.

Seeds are real functions in the target's own sources: top-level function
declarations with a body, spread evenly through ten of its largest files, marked
by inserting `@nothrow` into the existing JSDoc block where there is one. Every
placement is verified against `findMarks` before the file is written, so a run
cannot quietly measure fewer marks than it claims. Asking for 2,000 places
1,093 — the ten files run out of top-level function declarations first.

Per-rule times come from ESLint's own `TIMING`, so the rule's share of a run is
the host's accounting rather than the harness's.

### Machine

| | |
| --- | --- |
| CPU | 12th Gen Intel Core i7-12700H, 20 logical cores |
| memory | 32 GiB |
| OS | Windows 11, 10.0.26200 |
| Node | v22.12.0 |

A developer laptop, not an isolated benchmark host. The matrices below are
repeat-3 with a spread under ±2% within each cell, but see the correction next.

### One methodological correction, recorded because it changes how to read a rerun

The first pass ran each arm as a block: every baseline repeat, then every
treatment repeat. Its numbers drifted by more than **5×** on identical input —
the same baseline lint measured 84 s early in the run and 15 s an hour later.
Marking a tree rewrites 190,000 lines, and a cold read of them costs tens of
seconds on the machine that reads them warm; blocked arms measure that drift
rather than the rules.

The measured pass therefore **interleaves**: every arm runs back to back inside
one repeat, and each seed count opens with a discarded warm-up that pays for the
rewrite. Deltas below are between runs seconds apart. A blocked rerun will
produce numbers that look like a result and are not.

## Cold: what CI pays

### The whole of `src` — 601 files, 379,646 lines, 1,093 marks

Median of three interleaved repeats; process wall time, so startup, program
build and all.

| arm | wall | vs. baseline | our two rules | `no-floating-promises` | all rules |
| --- | --- | --- | --- | --- | --- |
| baseline | 24.0 s | — | — | — | 6.97 s |
| + preset, hybrid | 33.0 s | **+9.0 s (+38%)** | 5.48 s | 3.31 s | 14.53 s |
| + preset, declare-only | 30.3 s | +6.3 s (+26%) | 2.39 s | 3.46 s | 11.85 s |

**Inference is 3.1 s of that** — the difference between the two `no-escaping-throw`
figures (4.88 s hybrid, 1.79 s declare-only). Of the 9.0 s the preset adds, a
third is `@typescript-eslint/no-floating-promises`, a rule the preset turns on
but does not implement.

### `src/compiler` — 77 files, 192,636 lines, swept over seed count

The sweep is the measurement the gate actually needs: one number says what a run
costs, the curve says what *inference* costs.

| marks placed | baseline | + preset, hybrid | + preset, declare-only |
| --- | --- | --- | --- |
| 0 | 14.49 s | 17.52 s | 17.60 s |
| 100 | 14.47 s | 20.34 s | 17.57 s |
| 383 | 14.62 s | 20.54 s | 17.86 s |
| 1,093 | 14.62 s | 20.54 s | 18.10 s |

And the same runs as ESLint's per-rule accounting:

| marks | `no-escaping-throw` hybrid | `no-escaping-throw` declare | `valid-mark` |
| --- | --- | --- | --- |
| 0 | 0.35 s | 0.35 s | 0.32 s |
| 100 | 3.92 s | 0.48 s | 0.32 s |
| 383 | 4.04 s | 0.67 s | 0.32 s |
| 1,093 | 4.19 s | 1.05 s | 0.33 s |

Three things fall out of that table.

**The walk flattens.** From 100 marks to 1,093 — an eleven-fold increase — the
walk grows by 7%. The cost is bounded by the reachable subgraph of the *files
being linted*, not by how many marks point into it, because the memo is shared
across the seeds of a file. A codebase does not get slower to lint as its
adoption deepens, which is the property that makes incremental adoption viable.

**The fixed cost is small and real.** At zero marks the rule still costs 0.35 s
over 77 files: the mark scan and the per-file carrier. `valid-mark` costs a
further 0.32 s and does not move with seed count.

**Declare-only is not free.** It still walks escape sites, still consults the
chain, and floors more, so it reports *more*: 896 diagnostics against hybrid's
752 at 1,093 marks (1,247 against 1,034 over the whole of `src`). That is #4's
"strictly tightening" showing up as a bigger number, not a cheaper one.

### Against #3's estimate

#3 measured ~50 ms per 2,000 functions for a bare transitive walk. The shipped
engine costs ~4.9 s over a 12,326-function graph — two orders of magnitude more
per function. The gap is not the walk; it is everything the walk now carries:
the escape-site pass, hidden transfers, the condition machinery, the four-rung
resolver chain and the type queries each of those makes. #3's figure should not
be quoted as a cost model. The figure that matters is the one above: **9% of a
CI lint run**, and it is affordable.

## Warm: what an editor pays

One process, one live program, `src/compiler/utilities.ts` — 12,927 lines,
carrying 40 of the 323 marks the run placed — edited and re-linted. Median of
five.

| edit | baseline | + preset, hybrid | + preset, declare | preset's cost |
| --- | --- | --- | --- | --- |
| first lint (builds the program) | 4.78 s | — | — | — |
| touch — a comment at end of file | 641 ms | 832 ms | 696 ms | +191 ms |
| body — a statement inside a marked function | 609 ms | 802 ms | 716 ms | +193 ms |
| **split a cycle group** | 656 ms | 856 ms | 749 ms | +200 ms |
| **merge two cycle groups** | 586 ms | 761 ms | 698 ms | +175 ms |

The first lint under the first arm costs 4.78 s and the next two arms, in the
same process, cost 1.59 s and 0.54 s. That is #30 §G's claim confirmed
end to end: the program build is paid once by the host and shared, and the
marginal cost is the walk.

Under the preset, an editor re-lint of a 13,000-line file costs ~190 ms more
than it would without, of which inference is ~100 ms.

## The cycle groups

The memo unit is the SCC, so the condensation of a real codebase is what decides
whether group-granular invalidation is cheap. Over all of `src`:

| group size | groups |
| --- | --- |
| 1 | 10,826 |
| 2 | 30 |
| 3 | 10 |
| 4 | 6 |
| 5 | 2 |
| 6 | 2 |
| 7, 8, 9, 10, 11, 14, 15 | 1 each |
| 22 | 2 |
| 27 | 1 |
| 30 | 1 |
| **1,189** | 1 |

10,888 groups over 12,326 functions: **99.4% are singletons**, where "dirty the
whole group" and "dirty the function" are the same instruction. The non-trivial
tail is 62 groups and all but one are small enough that a whole group is a
rounding error.

The exception is real: one group of **1,189** functions, the mutually recursive
core of `checker.ts`. An edit to any one of those bodies would dirty all 1,189
under a cross-file memo.

**Read both numbers in one direction only.** The harness's graph admits *function
declarations* as nodes and edges between them; methods, arrows and function
expressions are neither. #30 §G's memo unit is an SCC over the whole unbridged-call
graph, which has all of those in it. Adding the missing nodes and edges can only
join groups, never split them — so **1,189 is a lower bound and 99.4% is an upper
bound**, and the direction the error runs is against the conclusion rather than
for it. Anyone designing a cross-file memo should re-measure over the engine's own
graph rather than take 1,189 as the ceiling.

### The two invalidation edits

#30 §G names an edit that **splits** a cycle group and one that **merges** two.
Both are real edits to `src/compiler/utilities.ts`, and both were checked against
the condensation rather than assumed — the harness reports what happened to the
group containing `isEntityNameExpression`:

| edit | what it does | group before | group after |
| --- | --- | --- | --- |
| split | `isEntityNameExpression` inlines the test instead of calling `isPropertyAccessEntityNameExpression`; the back edge is gone | 2 | 1 |
| merge | `isEntityNameExpression` gains a call to `isBindableStaticNameExpression`, which already reaches it; the added edge closes the path | 2 | 5 |

Neither costs more than an ordinary body edit (table above). **The reason is
worth stating plainly, because it is not "invalidation is cheap":** the engine's
memo does not outlive one file's analysis — `analyzeSourceFile` builds a fresh
resolver per file — so there is no memo to invalidate and no stale group to
leave behind. What the two edits price is the cost of re-walking one file, which
is what an editor pays for any edit at all.

So #30 §G's hazard is **dormant rather than discharged**. It becomes live the
day a memo is shared across files or across runs, and the 1,189-member group
above says what it would cost then: one body edit inside `checker.ts` dirties
1,189 functions. Anyone proposing that optimization should re-run this gate, and
should treat 1,189 as a floor on the number to design against rather than a
ceiling — see the caveat above.

## Adoption observations

Recorded along the way, as input to the docs ticket. Both actionable ones are
filed.

**1. `configs.recommended` cannot be loaded next to an existing
`@typescript-eslint` registration.** Dropping the preset into TypeScript's
config fails outright:

```
ConfigError: Config "nothrow/recommended": Key "plugins": Cannot redefine plugin "@typescript-eslint".
```

The preset registers its own copy of `@typescript-eslint/eslint-plugin` under
that name so `no-floating-promises` resolves; ESLint refuses a second
registration of a name unless it is the identical object, which it never is
across two installs. Every project with typed lint in CI already registers it —
which is to say, exactly the audience the preset is for. Filed as #89.

That is why every measured cell here is `preset-compat` rather than the untouched
preset: **the untouched preset has no timings because it does not load**, and
[`results/preset-load-failure.txt`](../tools/dogfood/results/preset-load-failure.txt)
is the whole of its result — the config, the command, and the error. The two arms
enable the same three rules; what `preset-compat` drops is a plugin
*registration*, and `no-floating-promises` then resolves against the copy the base
config registered.

**2. A declaration-merged lib member escapes the baseline, and one direction of
that is unsound.** TypeScript's repo carries its own `src/lib/*.d.ts`, which
merge with the real lib's declarations. In a four-line standalone project the
same shape reproduces: adding

```ts
interface Array<T> { push(...items: T[]): number; }
interface Math { max(...values: number[]): number; }
```

to a project flips both members. `Math.max`, clean before, starts flooring —
imprecise but safe. `xs.push`, correctly reported as throwing before (the ES
baseline colors `Array#push` throwing), becomes **silently accepted** — a
`@nothrow` function calling a builtin the baseline says can throw, passing.
Filed as #90, with the reproducer.

**3. Marks land where they are put, and the message contract holds up.** 1,093
mechanically chosen marks bound without a single `valid-mark` problem, and the
diagnostics they produced over `src/compiler` break down as:

| messageId | count |
| --- | --- |
| `unbridgedCall` | 306 |
| `inferredThrowingCall` | 248 |
| `conditionArgumentFloored` | 103 |
| `unbridgedHiddenTransfer` | 77 |
| `unbridgedConsumption` | 10 |
| `uncaughtThrow` | 4 |
| `conditionArgumentThrowing` | 4 |

A third are inference's own true positives — the body was read and it can throw
— rather than floors, which is the shape #4's hybrid model predicts and the
declare-only arm loses. Every floor message named its outs in-band as #30 §H
requires, and `conditionArgumentFloored` named the parameter path *and* the line
where the callee enters it (`createQueue` … `items.slice` … `core.ts:1785`),
which is the hardest clause in that contract to get right.

Read the absolute counts with limitation 2 above in mind: on this target the
baseline is answering for fewer lib members than it would on an ordinary
project, so the floor share here is an overestimate.

**4. Floor noise from third-party dependencies is not answered here, and this
target cannot answer it.** #47 asks for it among the adoption observations. Both
limitations above bear on it: TypeScript's compiler barely has a third-party
surface, and it vendors its own standard library, so what floors here is
first-party or lib rather than a package from npm. Recording it as unanswered
rather than generalizing from a number that would not mean what it looked like.
What would answer it is a second target chosen for the opposite property — a
dependency-heavy application with typed lint in CI — and the run is cheap now
that the harness exists: a target descriptor and one `cold` invocation. It is
not on the gate's critical path, because a dependency-heavy codebase floors
earlier and therefore walks *less*.

**5. The peer ranges hold.** The plugin loaded and ran against ESLint 10.1.0,
typescript-eslint 8.57.2 and TypeScript 6.0.2 with no override.

**6. `NOTHROW_COLOR_POLICY` behaves as `policy.ts` documents.** One process
measured both policies against one live program, because the lever is read when
a resolver is built rather than captured at module load. The warm harness
depends on that.

## Reproducing

```sh
git clone https://github.com/microsoft/TypeScript.git ts
cd ts && git checkout b465fdbfe175304d9b977da137b2c178ae1091d3 && npm ci
```

```sh
pnpm run build
pnpm run dogfood:scc    <ts> src/tsconfig-eslint.json src out.json
pnpm run dogfood:cycles <ts> typescript src/tsconfig-eslint.json src
pnpm run dogfood:cold   <ts> typescript 0,100,500,2000 3 baseline,preset-compat src/compiler
pnpm run dogfood:cold   <ts> typescript 2000 3 baseline,preset-compat src
pnpm run dogfood:warm   <ts> typescript 5
```

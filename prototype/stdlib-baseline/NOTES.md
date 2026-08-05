# Spike: can the standard-library baseline be generated?

**Ticket:** [Spike generating the standard-library baseline](https://github.com/MidnightDesign/no-throw/issues/22) ·
**Graduated from:** [Decide the standard-library baseline](https://github.com/MidnightDesign/no-throw/issues/21)

> PROTOTYPE — throwaway. The scripts exist to produce the numbers below, not to ship.

## Verdict

**Generate-then-review pays off, and it is cheaper than #21 priced hand-curation at.** Both candidates
work; they answer *different* questions and neither is redundant:

- **(a) Ecmarkup extraction is the worklist engine.** It parses ECMA-262 to per-builtin throw sites at
  usable fidelity, resolves abstract-op indirection transitively with **zero unresolved callees**, and
  bottoms out in a vocabulary of **86 distinct root causes** across 1,456 sites — small enough that a
  reviewer adjudicates *rules*, not sites.
- **(b) Type-conformant fuzzing is a real cross-check, not a formality.** Against the extractor's own
  proposed-clean set it produced **9 counterexamples in 3 classes**, two of which are genuine bugs in the
  spec-derived verdict. It cannot generate the baseline (it can only refute, and it reproduces just 47% of
  the throws the extractor predicts), but it earns permanent CI residence.

Total pipeline runtime: **~1.6 s** for the whole library (extract 263 ms · lib inventory 954 ms ·
classify 202 ms · fuzz 173 ms).

## What was built

| script | what it does |
| --- | --- |
| `extract.mjs` | Parses `spec.html` (ECMA-262, 2,262 clauses) → per-builtin throw sites with witness paths |
| `lib-members.mjs` | Enumerates TypeScript's `lib.*.d.ts` members keyed spec-style, tagged by lib target |
| `classify.mjs` | Joins the two, traces operands, proposes a verdict per site → `out/worklist.md` |
| `fuzz.mjs` | Drives each signature with type-conformant values; records observed throws |

`spec.html` and `out/` are gitignored (7.3 MB / 4.7 MB). `fetch-spec.sh` re-fetches; `WORKLIST-EXCERPT.md`
is a committed sample of what a reviewer actually signs.

## Answers to the ticket's questions

### 1. Does (a) parse to per-builtin throw sites at usable fidelity?

**Yes, and the abstract-op indirection is the *feature*, not the obstacle.** Ecmarkup emits exactly the
markup needed: `aoid=` cross-references on every abstract-op call, `?`/`!` abrupt markers as literal text
(§5.2.4.3), and `type="built-in function"` on the 526 builtin clauses.

- 547 abstract operations indexed, of which **219 can throw** (least fixpoint over `?`-edges).
- **0 unresolved callees** — the corpus is closed under its own cross-references.
- Longest witness path: **5 hops**. `Array.prototype.push` → `LengthOfArrayLike` → `ToLength` →
  `ToIntegerOrInfinity` → `ToNumber` → *"If arg is either a Symbol or a BigInt, throw a TypeError."*

Transitive resolution is required — a throw site 5 ops deep is invisible without it — but it is
mechanical, and the extractor carries the **triggering condition** up the chain, so what a reviewer reads
is a sentence, not a call graph. **477 of the 506 builtins with an algorithm have ≥1 throw site**, which
independently reconfirms #21's finding that the spec alone says everything can throw.

### 2. Can a throw site be mechanically classified against `lib.d.ts`?

**Partially — 63%, and the residue is the honest part.** Joining 1,357 lib members to the spec yields
**863 joined members / 2,392 throw sites** (the 494 unjoined are DOM, TS-only, and non-function members;
97 spec clauses have no lib member). Nine hazard buckets classify a site from the declared signature:

| bucket | verdict | rationale |
| --- | --- | --- |
| `ToObject`/`RequireObjectCoercible` on the receiver | type-excluded | receiver is the declaring interface, non-nullable |
| `RequireInternalSlot`, `ValidateTypedArray`, `This*Value` | type-excluded | brand discharged by the declared receiver type |
| `ToNumber`/`ToString`/`ToPrimitive` on a parameter | depends | excluded iff the declared type is coercion-safe |
| `ToIndex`, `GetViewValue`, `SetViewValue` | type-reachable | **range**-checks a value `number` does not bound |
| `Set`, `CreateDataPropertyOrThrow`, `DefinePropertyOrThrow` | type-reachable | frozen/sealed receivers are type-conformant |
| `Call`, `[[Construct]]`, `GetMethod` | **conditional** | runs a declared callable parameter — #21's group 3 |
| `[[Get]]`, `[[HasProperty]]`, `[[OwnPropertyKeys]]` | trust-base | accessors and Proxy traps are invisible to the type system (#14) |
| iteration ops | review | drives a user-supplied iterator |
| explicit throws | mostly review | value-dependent conditions |

Result: **543/863 (63%) auto-classified** — 377 group 1, 127 group 2, 39 group 3 — leaving **320 members
and 475 review sites** (of 2,392) for a human. On the ~200-member hot set the split is identical (63%).

Two findings inside that number:

- **Operand tracing is what makes it work.** A throw site's operand is usually a spec-local variable
  several steps downstream of the argument that produced it (`Let obj be ? ToObject(this value)` … then
  `? Set(obj, …)` five steps later). A small assignment-walk over the algorithm's steps attributes sites
  back to the receiver or a declared parameter; without it the "not traceable to a parameter" bucket
  swallows most of the corpus.
- **Worst-wins ranking hides group 3.** `Array.prototype.map` has *both* a conditional site (`Call` on
  `callbackfn`) and a type-reachable one (`CreateDataPropertyOrThrow` on the array it builds, plus
  `ArraySpeciesCreate` running a user `Symbol.species` constructor). Collapsing to one rank reports it as
  group 2 and loses the condition. **The generator must hand the reviewer the *set* of hazards; only the
  reviewer collapses it.** This is a direct constraint on how the review tool presents entries.

### 3. Does (b) find anything (a) misses?

**Yes — 9 counterexamples to proposed-clean verdicts, in 3 classes** (4,518 type-conformant calls over 607
members; 60 skipped because their declared types could not be modelled conformantly).

1. **A wrong bucket — `Atomics.add/and/or/sub/xor/exchange` (6).**
   `Atomics.add(new Int32Array(4), -1, 0)` → `RangeError: Invalid atomic access index`. Every argument is
   type-conformant (`index: number`). The classifier had filed `ValidateAtomicAccess` as a brand check when
   it also **range**-checks. A spec-only pipeline would have shipped six unsound group-1 entries.
2. **Outside the corpus — `String.prototype.toLocaleLowerCase/UpperCase` (2).**
   `'abc'.toLocaleLowerCase('')` → `RangeError: Incorrect locale information provided`. The validation lives
   in **ECMA-402**, which `spec.html` does not contain; ECMA-262 defers to it in prose. So *every*
   `toLocale*` member has throw sites structurally invisible to (a). This is a coverage boundary, not a bug —
   and only the empirical probe exposed it.
3. **A genuine judgment call — `Object.prototype.toLocaleString` (1).**
   `.call(Object.create(null))` throws (it invokes `this.toString()`), and a null-prototype object is not a
   lie to the type system the way a `Proxy` is. Whether this is trust-base or a real hazard is exactly the
   kind of call #21 reserved for a human — and the fuzzer put it on the human's desk.

**Sensitivity, honestly:** the fuzzer reproduces only **43/91 (47%)** of the throws the extractor predicts
for proposed group-2 members. Silence from it is nearly worthless as evidence; only its counterexamples
count. And its false-positive rate is a direct function of generator fidelity — an earlier, sloppier
version produced 13 counterexamples of which **all** were its own non-conformant arguments (unions like
`Int8Array<ArrayBufferLike> | …`, omitted required arguments). **Refusing to fuzz what it cannot model
conformantly is what makes the tool trustworthy**; guessing makes it a time sink.

### 4. Honest yield

| | number |
| --- | --- |
| lib.d.ts members (esnext + dom, TS 5.9.3) | 1,357 |
| joined to a spec clause | 863 |
| auto-classified with evidence | **543 (63% of joined, 40% of all)** |
| left for a human, with witness text pre-written | 320 members / 475 sites |
| pipeline runtime | ~1.6 s |

The generator does not get a reviewer to a *confident verdict* on anything by itself — no entry ships
unsigned. What it delivers is: a complete worklist, the triggering condition in prose per site, a
pre-classified 63% that the reviewer confirms rather than derives, and 9 hard counterexamples. Against
#21's ~1-day price for hand-curating a 50–100-member hot set, the pipeline covers **863 members** and cost
roughly half a session to build.

### 5. Does the extractor survive as the CI drift-detector?

**Symbol-set diffing alone is enough for the alarm; the extractor is needed for the fix.** Diffing the
member inventory across TypeScript 5.5.4 → 5.9.3 takes ~1 s and no spec at all: **72 members added, 1
removed** (`Math.f16round`, `Error.isError`, `ArrayBuffer.prototype.transfer`, the `Float16` family …).
Per #21 an unreviewed new member has no entry and floors, so the diff is the whole safety story. But a
diff cannot tell you what the 72 *are* — the extractor turns each into an evidence bundle for the same
review pass. Keep both; only the diff needs to gate CI.

## Recommendations to carry back to the map

1. **Ship generate-then-review**, with the ecmarkup extractor as the worklist engine and the fuzzer as an
   adversarial gate on every proposed group-1 entry (its counterexamples are hard refutations; run it in CI).
2. **The reviewer signs hazards, not verdicts** — the tool must present the full site set per member, since
   worst-wins collapses group 3 into group 2.
3. **`toLocale*` members need a separate ruling** — ECMA-402 is outside the extraction corpus, so they are
   not spec-derivable here. Simplest sound answer: floor the whole family.
4. **Coverage is now a real choice, not a guess**: 863 joined members at 63% pre-classification makes
   whole-library v1 coverage plausible; the ~200-member hot set is the same 63% and just smaller. That
   decision (and which lib targets ship) is the one this spike hands back.

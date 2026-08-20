# `@no-throw/es-baseline-tools`

Maintainer-side tooling. Not published, not a `nothrow` subcommand. It generates
the ES baseline shipped as engine data in `@no-throw/core`, and hosts the two CI
gates that keep that data maintainable.

## Generating

```sh
pnpm --filter @no-throw/es-baseline-tools run fetch-spec   # ECMA-262, cached, ~7.6 MB
pnpm run baseline:generate
```

Writes `packages/core/baseline-data/es.json` (the baseline, keyed by lib target)
and `es.symbols.json` (the symbol set it was generated from, for the drift
gate). Only generation needs the spec; both gates run over the generated data.

The pipeline:

1. **Ecmarkup extraction** — `aoid=` cross-references plus §5.2.4.3's `?`/`!`
   abrupt markers resolve abstract-operation indirection transitively. Each
   operation carries its **whole** set of root causes, not one witness: one
   witness can report the cause the declared type discharges and hide the one it
   does not, which is unsound rather than merely imprecise. Lifting reads the
   **guard** the call sits under, for one fact only: a step under `If x is an
   Object` cannot produce a cause about `x` being nullish or not an Object.
   That one guard is `ToPrimitive`'s, which every coercion goes through, and
   without it `ToString` of a declared `string` looks like it reaches
   `ToObject` on a couple of hundred members. An **early return** is read the
   same way and needs its own reading, because it protects its *siblings*
   rather than its children: `If iterable is either undefined or null, return
   map` is step 4 of `Map`, and steps 5 to 7 hold every hazard the constructor
   has. So a step carries the names an earlier return in its own list has ruled
   out — which is what a step's position, rather than its depth, is recorded
   for: two branches of an `If`/`Else` are both later than the `If` and neither
   runs after the other.
2. **Operand tracing** — a root cause is about the *callee's* parameter *i*, so
   lifting it into a caller re-resolves the expression passed at *i*,
   recursively, until the chain ends at a builtin's declared parameter or its
   receiver. Property reads become **path** segments, which is what lets
   `Array.prototype.push` be judged on `O.length` rather than on `O`.
3. **Classification** — hazards key on the **shape of the throw condition**,
   never on the root operation's name. That is a soundness requirement: an
   op-name enum fails silently in the unsafe direction when a name is misfiled.
   The chain is still read where one step decides what a whole family of
   members needs of its arguments: an internal method or
   `ValidateNonRevokedProxy` means Proxy behavior, and `ToPropertyKey` means
   any primitive will do — its coercion causes are lifted out of `ToPrimitive`
   and carry *that* name, so a root-keyed reading asks a `PropertyKey` to be
   neither Symbol nor BigInt and refuses `o[sym]`.
4. **Discharge against a live `ts.Program`** — the domains are computed from
   `ts.Type`s, which is why generation lives inside the engine rather than in a
   standalone script.
5. **Accessor facts** — two independent oracles (ECMA-262's `get X` clauses and
   `getOwnPropertyDescriptor` on the live builtin), combined in the safe
   direction. Safe members carry a positive `accessor: false` record, because
   absence must keep meaning floor.
6. **The gate, before emit** — a proposed-clean entry the gate refutes fails the
   run; one it cannot reach ships **floored**, and is listed under `unprobed`.

A member whose every reachable hazard sits behind an early return is clean
**given the position gets nothing**, which the entry states as a condition the
call site discharges. Which nothing is the guard's to say, so the extractor
records the spelling ECMA-262 used rather than flattening the two into one:
`If iterable is either undefined or null, return map` becomes
`param<N>=nullish`, which `new Map(null)` satisfies, and `If precision is
undefined, return ! ToString(x)` becomes `param<N>=undefined`, which
`(1).toPrecision(null)` does not — that call throws a RangeError.

ECMA-262's third spelling, `If x is null, return`, is read as no guard at all,
so a member behind one ships throwing. It would need a third condition form to
state truthfully, no builtin needs one, and matching it under either existing
form would claim the guard covers an omitted argument — the direction that
lies.

ECMA-402 reaches the same form from the other side. It is a different document
and its validation is structurally invisible here, but *which arguments it
reads* is not: ECMA-262 reserves the positions for it in the clause heading and
names them there — `String.prototype.localeCompare ( that [ , reserved1 [ ,
reserved2 ] ] )` — so a call that puts nothing there is on the near side of the
boundary. The reading needs ECMA-262's own steps to have been read, so it is
made only where there is an algorithm to read: a prose-only clause has none, and
its zero hazards are zero for want of a corpus rather than for want of a throw —
the same hole an alias left on eleven typed-array members until the fuzzer found
it. That leaves `localeCompare` the one member of the family it colors, and
`Number.prototype.toLocaleString`, the three `Date` ones and the rest shipping
throwing as before.

ECMA-402 writes no early return at all, so what its boundary admits is absence
and the `undefined` spelling and nothing else: `null` reaches
`CanonicalizeLocaleList`, which coerces it and throws. `param<N>=undefined`
states exactly that. It is the form that made the second narrowing this reading
used to carry unnecessary — stating `=nullish` and leaning on the declaration to
be unable to deliver `null` put the entry's truth in a fact the discharge
deliberately never reads, and a position declared able to be `null` had to keep
its hazard rather than understate it. Both go away: the condition says what the
boundary says, whatever the declaration happens to be.

Eleven entries carry an absence condition. `=nullish`, the wider form: the four
collection constructors under both lib targets that declare them.
`=undefined`, the narrow one: `Number.prototype.toPrecision`, and
`String.prototype.localeCompare` under both lib targets.

## The gates

```sh
pnpm run gate:fuzz               # every shipped clean claim, attacked
pnpm run gate:fuzz -- --self-check
pnpm run gate:drift              # symbol-set diff against the recorded set
pnpm run gate:drift -- --self-check
pnpm --filter @no-throw/es-baseline-tools run gate:drift -- --against /path/to/other/typescript.js
```

**The hostile fuzz gate.** Every proposed-clean entry — conditional ones
included — faces a type-conformant but hostile refutation attempt, inside the
scope the entry claims: a conditioned position is driven with nothing, with
`undefined`, and — where the condition is `=nullish` and the declared type
admits it — with `null`, because a color stated for `new Map()` says nothing
about `new Map(iterable)` and refuting it there would refute a sentence nobody
wrote. `null` where the type does not admit it is such a sentence, so that is
one more claim the gate leaves partly undriven rather than attacking out of
scope. The pool is
detached and shrunk buffers, a throwing-`Symbol.species` subclass, and
`Object.create(null)`; `Proxy` is excluded because it is trust base. A construct
signature is entered with `new` on two NewTargets — the constructor and a
subclass, since `class MyError extends Error {}` reaches the entry through its
implicit `super()` — and a call signature as a bare call. The rule for what may
be passed is **refuse to fuzz what you cannot model conformantly**: a
non-conformant argument manufactures a false counterexample, and a false
counterexample turns the gate from evidence into noise. An *unconstrained* type
parameter is not such a case — the caller picks the instantiation, so every value
conforms under some choice, which is what left `Map#get(key: K)` unprobed. An
object type the pool has no entry for is built out of the properties it declares
rather than refused, which is how `new Error(msg, options)` is reachable at all;
a property that cannot be modeled, or that is symbol-keyed, refuses the whole
value. An index signature says what a key holds when it is present and never
that any key is present, so the empty object conforms to every one of them. A
nominal type whose runtime wants internal slots this cannot forge is not
silently mismodeled either — it refutes, and a refutation with no recorded
counterexample fails the run.

Sensitivity sits near 80%, so **a green gate is not evidence of cleanliness,
only the absence of a refutation.** The gate's job is to fail. `--self-check`
plants known-throwing members as clean and fails if the gate does not refute
every one of them.

Counterexamples the extractor cannot see are recorded in
[`src/refutations.ts`](src/refutations.ts) with their evidence, and those entries
ship throwing. A counterexample outside that list fails the build.

**The precision report.** Attacking clean claims is what soundness needs, so
that is all the gate *fails* on — which left an entry that wrongly ships
`throwing` unprobed, unrefuted and unreported, findable only by marking a
function and counting the errors (#94). So the same run also names every
throwing entry it drove with conformant arguments and never made throw. It is a
report, never a failure: a throw the fuzzer cannot reproduce is evidence about
the fuzzer's reach as much as about the entry, and over-throwing costs precision,
not soundness.

**The drift gate.** A symbol-set diff of `lib.*.d.ts`. Newcomers have no entry
and therefore floor, so the gate surfaces them for classification rather than
blocking.

## Dials

See [`docs/baseline-dials.md`](../../docs/baseline-dials.md). Sign-off is
one-off doctrine; per release the cost is the symbol diff and the fuzz gate.

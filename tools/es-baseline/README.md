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
   does not, which is unsound rather than merely imprecise.
2. **Operand tracing** — a root cause is about the *callee's* parameter *i*, so
   lifting it into a caller re-resolves the expression passed at *i*,
   recursively, until the chain ends at a builtin's declared parameter or its
   receiver. Property reads become **path** segments, which is what lets
   `Array.prototype.push` be judged on `O.length` rather than on `O`.
3. **Classification** — hazards key on the **shape of the throw condition**,
   never on the root operation's name. That is a soundness requirement: an
   op-name enum fails silently in the unsafe direction when a name is misfiled.
4. **Discharge against a live `ts.Program`** — the domains are computed from
   `ts.Type`s, which is why generation lives inside the engine rather than in a
   standalone script.
5. **Accessor facts** — two independent oracles (ECMA-262's `get X` clauses and
   `getOwnPropertyDescriptor` on the live builtin), combined in the safe
   direction. Safe members carry a positive `accessor: false` record, because
   absence must keep meaning floor.
6. **The gate, before emit** — a proposed-clean entry the gate refutes fails the
   run; one it cannot reach ships **floored**, and is listed under `unprobed`.

## The gates

```sh
pnpm run gate:fuzz               # every shipped clean claim, attacked
pnpm run gate:fuzz -- --self-check
pnpm run gate:drift              # symbol-set diff against the recorded set
pnpm run gate:drift -- --self-check
pnpm --filter @no-throw/es-baseline-tools run gate:drift -- --against /path/to/other/typescript.js
```

**The hostile fuzz gate.** Every proposed-clean entry — conditional ones
included — faces a type-conformant but hostile refutation attempt. The pool is
detached and shrunk buffers, a throwing-`Symbol.species` subclass, and
`Object.create(null)`; `Proxy` is excluded because it is trust base. Bare type
parameters are refused, because an unrecorded constraint manufactures false
counterexamples — **refuse to fuzz what you cannot model conformantly.**

Sensitivity sits near 80%, so **a green gate is not evidence of cleanliness,
only the absence of a refutation.** The gate's job is to fail. `--self-check`
plants known-throwing members as clean and fails if the gate does not refute
every one of them.

Counterexamples the extractor cannot see are recorded in
[`src/refutations.ts`](src/refutations.ts) with their evidence, and those entries
ship throwing. A counterexample outside that list fails the build.

**The drift gate.** A symbol-set diff of `lib.*.d.ts`. Newcomers have no entry
and therefore floor, so the gate surfaces them for classification rather than
blocking.

## Dials

See [`docs/baseline-dials.md`](../../docs/baseline-dials.md). Sign-off is
one-off doctrine; per release the cost is the symbol diff and the fuzz gate.

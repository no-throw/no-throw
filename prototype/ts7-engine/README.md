# TypeScript 7 engine spike (#81)

Findings are in [NOTES.md](NOTES.md). This is how to reproduce them.

Everything here generates its own fixtures and spawns its own `tsgo` server, so
there is nothing to configure beyond the install.

```bash
npm install
```

`@typescript/native-preview` is pinned to `7.0.0-dev.20260707.2` deliberately —
the API is published under `unstable/` and the version is a date, so a range
would mean nothing.

**TypeScript is deliberately *not* a dependency here.** It has to be the same
instance `@nothrow/core` loads: node objects carry instance-local JSDoc caches,
so a second copy makes every mark silently invisible. Leaving it out lets it
resolve up to the workspace's own.

The scripts assume `@nothrow/core` is built (`pnpm run build` at the repo root).

## Chasing the anomaly

```bash
node deep-chain.mjs 500
```

The reported 35.7 s / 51 ms-per-request chain, rebuilt under the variants that
separate "chain" from "one file per function" from "inferred returns".

```bash
node deep-chain-shapes.mjs 500
```

Every other shape a "f0 ← f1 ← … ← f499" generator could have produced: nested
closures, one deep call expression, mutual recursion, widening and generic
chains.

```bash
node deep-chain-scaling.mjs
node deep-chain-scaling.mjs --repeat
node deep-chain-scaling.mjs --cold
node deep-chain-glob.mjs 500
```

Scaling to n=8000, the distribution across 12 fresh API instances, the
first-instantiation cost, and the one fixture-generator mistake that could turn
a 500-function project into a 1,898-file one.

## The API surface

```bash
node api-surface.mjs
```

Every checker operation the engine calls, every `Type`/`Symbol`/`Signature`
member it reads, and every `ts.*` helper — each *exercised* against a fixture
rather than read off the `.d.ts`, because declared and works are different
claims. Reports present, renamed or missing, and checks that the node members a
shim would stand on are there.

```bash
node api-churn.mjs
```

Downloads historical nightlies and diffs the `Checker` method set against the
pin, which is what a pin has to survive.

## What the engine costs over a wire

```bash
node request-cost.mjs                                   # dogfoods @nothrow/core
node marked-corpus.mjs 20 10 5                          # files x marks x depth
node request-cost.mjs fixtures/marked-20x10x5/tsconfig.json
```

Wraps the in-process `TypeFacts` in a recorder and runs the real engine, so the
wire cost is measurable without a server. Reports queries per operation, prime
batches, and the per-file distribution — which is what separates a fixed startup
cost from one that scales.

A mark-dense corpus is needed because dogfooding measures a project with three
marks in it, and therefore says nothing about what a mark costs.

## Both backends, compared

```bash
node tsgo-conformance.mjs                    # all 180 fixtures
node tsgo-conformance.mjs throwing-call-in-catch
```

Runs the real `@nothrow/core` over the conformance fixtures on the in-process
TypeScript 6 checker and on a TypeScript 7 client, and diffs the findings. Each
backend runs in its own child: the TypeScript 7 one works by resolving
`typescript` to a shim for everything under the engine, which is a module-level
substitution and therefore all-or-nothing.

Prints finding counts alongside the agreement count, because two empty reports
agree — a run that analyzed nothing would otherwise claim total success.

```bash
node wall-clock.mjs ../../packages/core fixtures/marked-20x10x5
```

The same two backends, timed end to end, with program build and analysis
separated — they answer different questions, and the crossover is the whole
result.

## Layout

| | |
|---|---|
| `tsgo/typescript-shim.mjs` | a `typescript` module that is really TypeScript 7 |
| `tsgo/facts.mjs` | `TypeFacts` over the tsgo checker; missing operations are collected, not thrown |
| `tsgo/loader.mjs`, `tsgo/register.mjs` | resolve `typescript` to the shim, for the engine only |
| `tsgo/backend-ts6.mjs`, `tsgo/backend-ts7.mjs` | one project, one backend, timed |
| `tsgo/sources.mjs` | what both backends agree is a fixture's own source |

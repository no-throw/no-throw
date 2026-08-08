# Linter/checker backends: TypeScript 7, oxlint, and a native engine

**Purpose:** establish whether `no-throw` can be prototyped against TypeScript 7 (`typescript-go`), oxlint, and a native (Rust/Go) implementation — and at what cost. Revisits the language/checker-access chain (#9 → #10), whose decision rested on a premise that TypeScript 7 retires.

**Date:** 2026-08-08 · **Graduated:** #81 (TS7 port spike), #82 (tsgolint measurement).

**Method:** primary sources, then **direct measurement against the real artifacts**. `@typescript/native-preview@7.0.0-dev.20260707.2` and `oxlint-tsgolint@7.0.2001` were installed and driven from a no-throw-shaped fixture; all timings below are measured on this machine (Windows 11, Node 22.12), not quoted. In-process baselines (~700 ms build, ~50 ms/2000 fn inference) are from the #3 spike note.

---

## TL;DR / bottom line

**All three prototypes are buildable today.** The first pass of this investigation framed them as blocked on TypeScript 7.1 and on upstream plugin APIs. That framing was wrong, and the correction matters: "no *stable* API" is not "no API", and "not accepting PRs" constrains upstreaming, not forking.

**The single most important finding:** for the TS7 path, API compatibility is *not* the problem — every checker method the engine calls is present, including the JSDoc access the `@nothrow` carrier depends on. The problem is **access shape**. Out of process, transport costs ~0.2 ms per round trip, and the engine currently pulls types node-by-node inside a recursive walk. Naively ported that is ~24x worse than the entire in-process pass. The API's array overloads collapse N queries into one request (25x measured), so the port is viable **iff the engine is restructured from per-node pull to per-pass batch** — a change that is legal in-process too, and therefore not throwaway work.

**The second finding:** "an oxlint version" and "a native version" are **one artifact**, not two. There is no supported path to a third-party type-aware oxlint rule at either layer, so both reduce to forking tsgolint and writing a rule in Go — which also means a second implementation of the color algebra, i.e. exactly the maintenance fork #10 argued against.

| Target | Verdict |
|---|---|
| **TypeScript 7** | ✅ **Buildable now.** `@typescript/native-preview` ships a working sync API; full checker surface present incl. `getJsDocTags`. AST is client-side and free; only type queries cross the wire. Real work is the batching restructure, not the port. On the forced-migration path — do this first. |
| **oxlint** | ⚠️ **Only by forking tsgolint.** JS plugins get no type information ("Not supported yet"); tsgolint has no third-party rule API. Not an effort question — the information is not exposed. |
| **Native (Rust)** | ❌ **Still a misnomer**, for #9's original reason, now demonstrated by oxlint itself: it went Rust and still delegates every type-aware rule to a Go backend. |
| **Native (Go)** | ⚠️ **Buildable now, as the same artifact as oxlint.** Fork tsgolint. Costs a second engine, and stands on `go:linkname` shims its own authors disown. Scope as measurement, not product. |

---

## Where TypeScript 7 actually stands

TypeScript 7.0 shipped 2026-07-08. Microsoft: "TypeScript 7.0 is made available, but it does not ship with an API", with "a new (and different) API" expected in 7.1. typescript-eslint closed its TS7 support request as not planned and pins `typescript >=4.8.4 <6.1.0`; ts-morph, ts-jest and the Vue/Svelte/Astro template checkers are in the same position. The sanctioned interim is `@typescript/typescript6`, which aliases `typescript` to the 6.0 API while TS7's `tsc` does builds.

So `no-throw` is not broken by TS7 adoption today — it is in the same lifeboat as typescript-eslint. Two consequences worth recording:

**A live defect.** `@nothrow/core` and `@nothrow/eslint-plugin` both declare `"typescript": ">=5.0.0"`, which is unbounded and therefore *satisfied* by TS 7.x. A consumer installing TypeScript 7 gets no unmet-peer warning and then a runtime crash — the mirror image of #66/#74, where the `eslint` range was too narrow. Tracked separately.

**A soundness gap.** Under the `@typescript/typescript6` split, the build type-checks with the Go checker while `no-throw` analyzes with the JS checker. Two checkers, one program. For a project carrying soundness as a standing steer, analyzing against a different checker than the one that defines the program's types deserves an explicit position rather than silence.

### The API that does exist

`@typescript/native-preview@7.0.0-dev.20260707.2` exports:

```
"./unstable/sync":  "./dist/api/sync/api.js"     — blocking client (libsyncrpc, NAPI over stdio)
"./unstable/async": "./dist/api/async/api.js"
"./unstable/ast":   "./dist/ast/index.js"        — client-side AST, is/factory/utils/scanner/visitor/clone
"./unstable/proto": "./dist/api/proto.js"
```

Design confirmed in `microsoft/typescript-go` discussion #455: out-of-process by intent ("API consumers will typically not communicate within the same process ... a message-passing scheme, typically over an IPC layer"), with in-process rejected (Go has no stable ABI) and WASM rejected for threading. Synchronous access is solved by `libsyncrpc` blocking on the pipe, which means **ESLint's sync-only `Linter` is no longer the blocker it was in 2025** — ESLint still has no async parser plans and no longer needs them.

Every method the engine uses is present on `Checker`:

| Engine call | Sites | tsgo API |
|---|---|---|
| `getTypeAtLocation` | 16 | ✅ + array overload |
| `getSymbolAtLocation` | 12 | ✅ + array overload |
| `getApparentType` | 9 | ✅ |
| `getPropertyOfType` | 8 | ✅ |
| `getTypeOfSymbol` | 5 | ✅ + array overload |
| `getResolvedSignature` | 5 | ✅ |
| JSDoc tag access (the carrier) | — | ✅ `getJsDocTags`, `getJsDocTagsOfSymbol` |

The JSDoc entry was the sharpest risk going in. The 7.1 API is explicitly *curated* rather than complete ("exposing all functionality will be impractical ... a more curated API ... informed by critical use-cases (e.g. linting ...)"), and had JSDoc access been dropped, the `@nothrow` tag would have had no TS7 story and the manifest would have become load-bearing rather than an escape hatch. It survives.

### Verified end to end

Driving a no-throw-shaped fixture (a `@nothrow`-marked clean function, an unmarked thrower, and a marked caller that calls both):

```
  Number()    -> sig resolved | return number  | tags []          | @nothrow: false
  isNaN()     -> sig resolved | return boolean | tags ["param"]   | @nothrow: false
  safeParse() -> sig resolved | return number  | tags ["nothrow"] | @nothrow: true
  risky()     -> sig resolved | return number  | tags []          | @nothrow: false
```

`getApparentType` → `getPropertyOfType` → `length` also resolves, so #14's hidden-transfer path is served.

---

## Measurements

The API ships timing instrumentation (`collectTiming`: client round-trip, server processing time, and the transport delta), so the figure #9 explicitly refused to guess is directly measurable rather than inferred.

Fixture: N independent functions, one call site each, `strict: true`.

| n | updateSnapshot | AST walk | unbatched types | batched types | speedup |
|---:|---:|---:|---:|---:|---:|
| 10 | 155.7 ms (3 reqs) | 3.4 ms — **0 reqs** | 10.8 ms / 10 reqs / 4.1 ms transport | 0.9 ms / 1 req | 12x |
| 100 | 122.6 ms (3 reqs) | 3.9 ms — **0 reqs** | 26.9 ms / 100 reqs / 16.4 ms transport | 1.2 ms / 1 req | 22x |
| 500 | 154.0 ms (3 reqs) | 20.5 ms — **0 reqs** | 132.8 ms / 500 reqs / 98.8 ms transport | 5.3 ms / 1 req | 25x |

**The AST is fully client-side.** `requests=0, nodesFetched=0` across the whole recursive walk after `getSourceFile`. Every syntactic predicate in `transfers.ts` and `escapes.ts` costs nothing, and `node.parent` works. Only type queries cross the wire. This is the most favorable possible split for an engine that is mostly syntax with type queries at the escape sites.

**Transport settles at ~0.2 ms per round trip.** Against #3's in-process baseline of ~50 ms / 2000 functions: a naive port at a conservative three queries per function is ~6000 round trips ≈ **1.2 s of pure transport, ~24x worse than the entire in-process pass**. Batched, it is single-digit milliseconds. Hence the architectural conclusion — the port is a restructure, not a translation.

### An unexplained anomaly

A fixture of 500 functions in a **transitive call chain** (`f0 <- f1 <- ... <- f499`, every signature explicitly annotated) behaved completely differently:

```
program load + first fetch : 35669.2 ms
local AST walk             :  1105.2 ms
unbatched (499 nodes)      : 27950.0 ms | server 2042.6 ms | transport 25608.9 ms  => 51.3 ms/req
batched   (499 nodes)      :    23.0 ms | server    4.2 ms | transport     6.9 ms
```

35.7 s to load, and 51 ms/request against 0.20 ms/request for independent functions. This is server-side, not transport. **The fixpoint walks exactly this shape.** If it is a real checker pathology rather than a fixture artifact, it dominates every other number in this document, so #81 chases it first rather than last.

---

## oxlint

Two surfaces, both closed to us.

**JS plugins.** ESLint-v9-compatible API, alpha, actively developed toward "100% of ESLint's plugin API surface". AST traversal, scope analysis, fixes, selectors, `SourceCode` — but type-aware rules are listed as **"Not supported yet"** and no type information reaches custom plugins. `no-throw` is not incidentally type-aware; `resolve-color.ts` alone is 1,395 lines driven by the checker. Without type information there is no product. Not an effort question.

**tsgolint.** Type-aware rules run in Go. oxc forked typescript-eslint's prototype with permission; stable since 2026-07-22, 59 of 61 typescript-eslint type-aware rules, 12–18x faster than ESLint on their published benchmarks. But: no third-party rule API, "We are not currently accepting PRs for new rules beyond what `typescript-eslint` supports", and per oxc "plugins in a non-js language is not currently possible".

One lead was chased and refuted: a `typescript-oxlint` package claimed in secondary sources to offer type-aware JS plugins does not exist — the npm registry returns 404.

**Substitution is trivial, though.** `oxlint-tsgolint` ships a nine-line shim:

```js
const exePath = require.resolve(
  `@oxlint-tsgolint/${process.platform}-${process.arch}/tsgolint${process.platform === 'win32' ? '.exe' : ''}`,
);
child_process.execFileSync(exePath, process.argv.slice(2), { stdio: 'inherit' });
```

A plain platform binary behind a resolvable package, invoked over stdio. Pointing oxlint at a self-built fork is a pnpm override.

---

## Native

**Rust remains a misnomer for the analysis**, exactly as #9 concluded. No production Rust TS checker exists, and oxlint is the proof rather than the counterexample: it went Rust and still spawns a Go backend for every type-aware rule.

**Go on typescript-go is real but stands on a hack.** tsgolint reaches the checker through `go:linkname` shims — `shim/ast`, `shim/checker`, `shim/compiler` — and its own ARCHITECTURE.md says: "This approach is not recommended for production use. We're waiting for official typescript-go APIs." Rules are Go visitors registering on AST kinds with direct checker access, so the ergonomics are good; the foundation is what is disowned.

**The cost that decides this is ongoing, not up-front.** A Go rule means two implementations of the color algebra, kept in step only by the conformance suite. That is the maintenance fork #10 argued against, and it is a legitimate reason to hesitate in a way that "it is a lot of code" would not be.

---

## What this changes about #10

#10 chose TypeScript in-process on an explicit premise: `no-throw` is a **guest** that reuses the host's live `ts.Program` for ~50 ms marginal, where a native core would re-pay the whole ~700 ms build. That reasoning was correct and remains correct for the ESLint plugin. Two amendments:

1. **The premise has an expiry date that is not ours to set.** When the ecosystem's checker is Go, "reuse the host's JS program" stops being available — not because we chose native, but because the host did. #81 exists so that migration is a planned move rather than a forced one.
2. **The escape hatch #10 parked is CLI-shaped, not ESLint-shaped.** #10 retained a "native / warm-daemon" hatch for the case where there is no host to piggyback on. That case already exists in the product: `nothrow emit` owns its program and pays the full build. If the native path is ever worth taking, that is where it pays, and the measured tsgo build times (~120–155 ms on small fixtures, against #3's ~700 ms in-process) are the first evidence in its favor.

---

## Graduated

- **#81 — Spike the engine on the TypeScript 7 API.** The checker seam, the batching restructure, the deep-chain anomaly, and what pins us to a nightly. First, because it is on the forced-migration path and its central finding is needed regardless of which linter hosts us.
- **#82 — Measure what a tsgolint-hosted engine buys.** Scoped as a throwaway measurement, sequenced after #81 so the Go path is compared against a *batched* TS7 engine rather than flattered by an unbatched one.

## Sources

- [Announcing TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/) — no API in 7.0; 7.1 plan; `@typescript/typescript6`
- [microsoft/typescript-go discussion #455](https://github.com/microsoft/typescript-go/discussions/455) — API story: IPC by design, `libsyncrpc`, curated surface, handle-based objects
- [`@typescript/native-preview`](https://www.npmjs.com/package/@typescript/native-preview) — the API measured here
- [oxlint JS Plugins](https://oxc.rs/docs/guide/usage/linter/js-plugins.html) — type-aware rules "Not supported yet"
- [Oxlint Type-Aware Linting Stable](https://oxc.rs/blog/2026-07-22-type-aware-linting-stable) — tsgolint v7, 59/61 rules, benchmarks
- [oxc-project/tsgolint](https://github.com/oxc-project/tsgolint) — `go:linkname` shims; "not recommended for production use"
- [oxc discussion #20086](https://github.com/oxc-project/oxc/discussions/20086) — custom rules must be JS plugins
- [typescript-eslint #12518](https://github.com/typescript-eslint/typescript-eslint/issues/12518) — TS 7.0.2 support closed as not planned
- [typescript-eslint #10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940) — tsgo type information: async, serialization, ESLint parser constraints

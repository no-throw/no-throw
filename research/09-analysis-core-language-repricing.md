# Re-pricing the `no-throw` analysis core across implementation-language / checker-access architectures

**Purpose:** decide whether the "core + thin adapters, ESLint-first" engine (option b) still pencils out if the analysis core is written in Go or Rust instead of JS/TS — specifically, whether the load-bearing assumption of (b) (*the core holds a live in-process `ts.Program` and reuses the ~700 ms program build the host already paid*) survives a language boundary. Feeds the language-decision chain (#9 → #10 → #4 → #5 → #6).

**Date:** 2026-07-09 · **Resolves:** #9 (AFK research, re-price core across languages).

**Method:** primary sources only — `microsoft/typescript-go`, `oxc-project/tsgolint` + its `ARCHITECTURE.md`, `typescript-eslint/tsgolint`, the oxc/VoidZero type-aware announcements, typescript-eslint's project-service post, napi.rs, and Microsoft's "10x Faster TypeScript". In-process baselines (~700 ms build, ~50 ms/2000 fn inference) are from the issue-#3 spike note (`research/03-eslint-rule-capability-matrix.md`).

---

## TL;DR / bottom line

**The single most important finding:** the "reuse the host's already-built program" benefit is **JS/TS-only**. It does **not** survive a language boundary — not for Go, not for Rust, not for WASM, not for napi-rs. A TS `ts.Program`/`TypeChecker` is a live JS-heap object graph (closures, symbol caches, lazily-computed types); it cannot be handed to a Go or Rust process, and it cannot cross a process boundary without re-serialization that would throw away exactly the thing you were reusing. The moment the core is non-JS, the type checker must live **on the core's side of the boundary**, be **built fresh by the core**, and only **diagnostics** (positions + messages) cross back. This is not a hypothetical — it is precisely how oxlint + tsgolint are built today.

| Architecture | Re-priced verdict (1–2 lines) |
|---|---|
| **1. JS/TS core, in-process compiler API** | ✅ Option (b) as designed. Core reuses the host's `ts.Program` via typescript-eslint `ParserServices` (`services.program`). The ~700 ms build is paid once by the host and shared; inference (~50 ms/2000 fn) runs on the same JS objects with **zero serialization**. The only architecture where the reuse benefit is real. |
| **2. Go core on `typescript-go`** | ⚠️ Reuse benefit **collapses**. `typescript-go` has **no public/embeddable API** ("API: not ready"); a Go core must build its **own** `typescript-go` program (as tsgolint does), so the ~700 ms build is **paid again**, in a *different* program the JS host can't share. Type-aware analysis must be **reimplemented in Go** and run in-process next to the Go checker. Bridge = subprocess: paths/config in, diagnostics out. Ships a platform-specific Go binary. |
| **3. Rust core, IPC to `typescript-go`/`tsserver`** | ⚠️ Worst fit for the *analysis* core. No production Rust TS checker exists; napi-rs is Node↔Rust FFI, **not** a checker. A Rust "core" cannot do the transitive type-walk in Rust — the walk has to run where the checker runs (Go/TS). So Rust degrades to a **frontend/CLI** (à la oxlint) that spawns a Go/TS backend which does the real work. "Rust core" is a misnomer for our type-aware analysis. Ships Rust binary **+** bundled checker (two native components). |

Recommendation this feeds into #10: **stay JS/TS in-process** for the analysis core unless a spike shows the out-of-process build+IPC cost is acceptable *and* the reuse loss is worth some other win (raw checker speed). Every non-JS option trades away (b)'s core premise.

---

## Comparison table

| Axis | 1. JS/TS in-process | 2. Go core on `typescript-go` | 3. Rust core, IPC to checker |
|---|---|---|---|
| **How it reaches type info** | Live in-process `ts.Program`/`TypeChecker`, handed over by host (typescript-eslint `ParserServices`). No boundary. [ts-eslint custom-rules](https://typescript-eslint.io/developers/custom-rules) | Builds its **own** `typescript-go` program in-process (Go); reaches checker via `go:linkname` shims of internal APIs — no public API exists yet. [tsgolint ARCHITECTURE](https://github.com/oxc-project/tsgolint/blob/main/ARCHITECTURE.md) · [tsgo README "API: not ready"](https://github.com/microsoft/typescript-go) | Cannot host a TS checker itself. Spawns a Go/TS process (typescript-go/tsgolint-shaped, or tsserver/LSP). Type reads happen on the *other* side of the boundary. [napi.rs](https://napi.rs/) (FFI, not a checker) |
| **Is the ~700 ms build reused or re-paid?** | **Reused** — host paid it once; core shares the same object. Inference ~50 ms/2000 fn on top. [#3 note](./03-eslint-rule-capability-matrix.md) | **Re-paid** — different program, different runtime; the JS `ts.Program` is unusable from Go. (`typescript-go` is generally 8–12× faster at building, so the re-paid build is *cheaper* but still re-paid; exact figure = **spike**.) [10x TS](https://devblogs.microsoft.com/typescript/typescript-native-port/) | **Re-paid** on the Go/TS side; Rust never holds a program at all. |
| **Can type info cross the boundary?** | No boundary. | **No** — only **diagnostics** cross (paths/config in → structured diagnostics out). Rules run inside Go next to the checker. [oxc type-aware](https://oxc.rs/blog/2025-12-08-type-aware-alpha.html) | **No** — same constraint; the whole transitive pass must live on the checker's side. |
| **Precedent** | typescript-eslint's entire typed-linting stack (projectService). [project-service](https://typescript-eslint.io/blog/project-service/) | **tsgolint** (Go, on typescript-go); typescript-eslint calls it a not-production prototype. [ts-eslint/tsgolint](https://github.com/typescript-eslint/tsgolint) | **oxlint** = Rust frontend delegating **all** type-aware work to the tsgolint **Go** backend. [oxc type-aware](https://oxc.rs/blog/2025-08-17-oxlint-type-aware) |
| **Distribution** | Pure-JS npm; `typescript` peer dep; no native binary; no platform matrix. | Platform-specific **Go binary** + bundled `typescript-go` (optionalDependencies pattern). Separate npm pkg in oxlint's case (`oxlint-tsgolint`). [oxc docs](https://oxc.rs/docs/guide/usage/linter/type-aware.html) | **Two** native components: Rust binary **+** checker binary. Largest footprint, biggest CI/supply-chain surface. |
| **Impact on option (b)** | (b) holds exactly. No bridge. | (b)'s in-process reuse → **IPC/subprocess bridge**; core owns a fresh program; host program discarded (and in an ESLint host you may pay the build **twice**). | Same collapse, plus Rust can't even own the analysis; it owns only orchestration + printing. |

---

## Per-architecture findings

### 1. JS/TS core, in-process compiler API — the (b) baseline

**(a) Type-info access & latency.** A JS/TS core runs in the same V8 heap as the host. Under ESLint, typescript-eslint's `parserOptions.projectService` builds a `ts.Program` using "the same TypeScript 'Project Service' APIs that editors such as VS Code use to create Programs" ([project-service post](https://typescript-eslint.io/blog/project-service/)), and exposes it to a rule via `ESLintUtils.getParserServices(context).program` ([custom-rules docs](https://typescript-eslint.io/developers/custom-rules)). The core reads types directly off that live `TypeChecker`. Re-pricing #3: the **~700 ms `createProgram` cost is paid once by the host and shared**; the **~50 ms / 2000-fn** transitive pass runs on the same in-memory nodes with **no serialization** ([#3 note](./03-eslint-rule-capability-matrix.md)). typescript-eslint's own framing is "lint time ≈ build time" ([typed-linting perf](https://typescript-eslint.io/troubleshooting/typed-linting/performance/)) — i.e. the build dominates and is unavoidable for *any* type-aware rule, so sharing it is the whole game.

**(b) Precedent.** This is the mainstream path: every typed typescript-eslint rule works this way today. It is the reference implementation for "reuse the host's program."

**(c) Distribution.** Pure-JS npm package; `typescript` as a peer dependency; **no native binary, no per-platform build matrix, no extra CI artifact**. Runs anywhere Node runs. Smallest possible install/footprint.

**(d) Impact on (b).** None — this *is* (b). The core holds the live program, reuses the host's build, and the ESLint adapter stays thin.

---

### 2. Go core on `typescript-go` (`tsgo` / "TypeScript 7" / Project Corsa)

**(a) Type-info access & latency.** Microsoft's Go port is real and fast — Anders Hejlsberg's ["A 10x Faster TypeScript"](https://devblogs.microsoft.com/typescript/typescript-native-port/) reports **8–12× on full builds** and **VS Code editor startup 9.6 s → 1.2 s**; TS 7.0 RC shipped 2026-06-18 ([TS 7.0 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)). **But there is no way for a JS ESLint adapter to hand a live in-process program to Go**, and `typescript-go`'s own status page lists **`API: not ready`** — it ships a CLI (`tsgo`) and an in-progress LSP, no stable embeddable Go checker API, and the repo is explicitly slated to be "merged into `microsoft/TypeScript`" long-term ([tsgo README](https://github.com/microsoft/typescript-go)). Consequence: a Go core must **build its own `typescript-go` program from scratch**, exactly as tsgolint does — oxc's docs state plainly that "**tsgolint (Go) Builds TypeScript programs using `typescript-go` and executes type-aware rules**" ([type-aware docs](https://oxc.rs/docs/guide/usage/linter/type-aware.html)). So the ~700 ms build is **re-paid inside the Go process**, on a *different* program object; the JS host's program is dead weight to it. The transitive inference (#3's ~50 ms/2000 fn) would have to be **reimplemented in Go** — but then it runs **in-process next to the Go checker**, so the type *reads* are native and boundary-free.

**(b) Precedent — tsgolint.** tsgolint is the canonical example. It "accesses typescript-go internals via Go's `linkname` directives," through shim layers `shim/ast`, `shim/checker`, `shim/compiler`, and warns "**This approach is not recommended for production use. We're waiting for official typescript-go APIs.**" ([ARCHITECTURE.md](https://github.com/oxc-project/tsgolint/blob/main/ARCHITECTURE.md)). It uses the TS AST directly — "No more TS AST -> ESTree AST conversions. TS AST is directly used in rules" ([ts-eslint/tsgolint README](https://github.com/typescript-eslint/tsgolint)) — and shares "TypeScript programs across workers" ([ARCHITECTURE.md](https://github.com/oxc-project/tsgolint/blob/main/ARCHITECTURE.md)). Published costs (whole-run, program build folded in, **not reused from any host**): vscode 167.8 s → 4.89 s (34×), microsoft/typescript 47.4 s → 2.10 s (23×), typeorm 27.3 s → 0.93 s (29×), vuejs/core 20.7 s → 0.95 s (22×) — "**20–40× faster than ESLint + typescript-eslint**" ([tsgolint README](https://github.com/oxc-project/tsgolint)). **Status caveat:** typescript-eslint say tsgolint "is a prototype in the early stages of development. It is not actively being worked on, nor is it expected to be production ready," and they have "**no plans to take significant development budget away from typescript-eslint to work on tsgolint**" ([ts-eslint/tsgolint README](https://github.com/typescript-eslint/tsgolint)); the actively-developed fork is now `oxc-project/tsgolint` for oxlint.

**(c) Distribution.** Ships a **platform-specific Go binary** plus the bundled `typescript-go`. In oxlint's world this is a separate npm package (`oxlint-tsgolint@latest`, [type-aware docs](https://oxc.rs/docs/guide/usage/linter/type-aware.html)) using the per-platform-binary (optionalDependencies) pattern. Bigger install, a platform build matrix, and "very large codebases may encounter high memory usage" ([type-aware docs](https://oxc.rs/docs/guide/usage/linter/type-aware.html)).

**(d) Impact on (b).** The in-process program-reuse **collapses into a subprocess bridge**. Bridge shape (from tsgolint precedent): the JS host spawns the Go binary; sends **file paths + rule config + tsconfig location**; the Go side builds and **owns** its own `typescript-go` program, runs the (Go-reimplemented) transitive analysis in-process with the checker, and returns **structured diagnostics** over the boundary — "oxlint CLI ... Passes paths and configuration to tsgolint" and "tsgolint ... Returns structured diagnostics. ... No type data is passed back" ([oxc type-aware alpha](https://oxc.rs/blog/2025-12-08-type-aware-alpha.html)). Note the ESLint-host double-cost: if the surrounding ESLint run *also* uses typescript-eslint typed rules, that host builds its JS program **and** the Go core builds a second `typescript-go` program — two full builds for one lint run.

---

### 3. Rust core, IPC to `typescript-go` / `tsserver`

**(a) Type-info access & latency.** There is **no production-grade native Rust TS type checker**. oxc's team says so directly: "writing our own type-inferencer or type-checker was not feasible due to the challenge of keeping up with a fast-moving target like TypeScript," noting prior attempts (ezno, stc, Biome 2.0) hit the same wall — which is exactly why oxlint delegates to tsgolint instead of building Rust type-aware rules ([oxc type-aware preview](https://oxc.rs/blog/2025-08-17-oxlint-type-aware), [VoidZero announcement](https://voidzero.dev/posts/announcing-oxlint-type-aware-linting)). So a Rust core must reach a checker **across a boundary**: either (i) spawn a Go/TS process (typescript-go/tsgolint-shaped) that does the type work, or (ii) drive `tsserver`/the typescript-go LSP over stdio. **Crucially, our analysis needs to walk the call graph reading arbitrary types transitively — that walk has to execute where the checker lives (Go/TS), not in Rust.** Type info cannot be shipped into Rust without re-serialization that defeats the purpose. So "Rust core" cannot own the type-aware analysis; Rust is reduced to frontend/CLI + orchestration + diagnostic printing — precisely oxlint's split: "Oxlint (Rust) Handles file traversal, ignore logic, configuration, non-type-aware rules, and reporting" while "tsgolint (Go) Builds TypeScript programs ... and executes type-aware rules" ([type-aware docs](https://oxc.rs/docs/guide/usage/linter/type-aware.html)).

**napi-rs is not a loophole (important distinction).** napi-rs is "a framework for building pre-compiled Node.js addons in Rust" via Node-API — a **Node↔Rust FFI bridge**, and it "has nothing to do with TypeScript type checking" ([napi.rs](https://napi.rs/)). It lets a Rust core run *inside* the Node/ESLint process, but it still **cannot receive the host's live `ts.Program`**: napi-rs marshals values across FFI, not a live JS `TypeChecker` with its closures and lazy caches. Even napi-embedded, Rust would still need its own checker (a Go/TS subprocess). napi-rs answers "how does a Rust core plug into Node," never "how does Rust get a checker."

**(b) Precedent — oxlint.** oxlint is the working proof: a Rust linter that does **not** run type-aware rules in-process and instead **shells out** to the Go tsgolint backend, receiving only diagnostics. Its two components "are compiled into their own binaries," Rust and Go respectively ([oxc type-aware preview](https://oxc.rs/blog/2025-08-17-oxlint-type-aware)). Published whole-run costs (alpha): vuejs/core 2.531 s vs ESLint 20.800 s (8.22×), outline/outline 4.448 s vs 55.070 s (12.38×) ([type-aware alpha](https://oxc.rs/blog/2025-12-08-type-aware-alpha.html)); preview file-count timings: napi-rs 144 files 1.0 s, preact 245 files 2.7 s, rolldown 314 files 1.5 s, bluesky 1152 files 7.0 s ([type-aware preview](https://oxc.rs/blog/2025-08-17-oxlint-type-aware)). None of these reuse a host program — each builds its own via tsgolint.

**(c) Distribution.** Heaviest: a **Rust binary + a bundled checker binary** (typescript-go, or a shipped tsserver), each platform-specific. Two native artifacts to build, sign, and ship; largest install footprint and CI/supply-chain surface.

**(d) Impact on (b).** (b)'s premise is doubly violated: not only does the in-process program-reuse collapse into an IPC/subprocess bridge, but Rust cannot even host the analysis, so the "core" you'd actually write the throwing/non-throwing transitive logic in is **Go/TS on the far side of the bridge**, with Rust as a thin CLI shell. Choosing Rust for the analysis core is choosing to write the analysis in Go anyway.

---

## Others surfaced (beyond the 3 seeds)

- **LSP / `tsserver`-over-stdio (out-of-process point queries).** `typescript-go`'s language service is the only semi-public cross-process way to reach type info, but it is **"in progress"** ([tsgo README](https://github.com/microsoft/typescript-go)) and, more fundamentally, LSP exposes *editor* operations (hover, diagnostics, references), **not** a "walk the whole call graph reading arbitrary types" API. Our transitive inference would decompose into thousands of per-symbol stdio round-trips — an architecturally disqualifying latency shape for the core (fine for one-off point queries, not for whole-program inference). Exact round-trip cost is unpublished → would need a spike to *quantify*, but the shape alone rules it out for the core.
- **Persistent daemon / warm program.** Keep a long-lived process holding a pre-built program to amortize the ~700 ms build across runs (the tsserver/watch idea). `typescript-go`'s watch mode is only a **"prototype"** ([tsgo README](https://github.com/microsoft/typescript-go)) and tsgolint ships no daemon. This is the one idea that could recover build-amortization for a non-JS core in an editor loop — but it's unbuilt and unmeasured → spike.
- **WASM-compiled checker (in-process, language-neutral).** Compile `typescript-go`/tsc to WASM and run it in-process in Node or Rust. No published embeddable WASM checker build exists; and WASM-in-Node still **cannot receive the host's live JS `ts.Program`** (separate linear-memory heap). napi-rs advertises "seamless WebAssembly integration" ([napi.rs](https://napi.rs/)) but that's for Rust addons, not a TS checker. No precedent; pure research spike; not near-term viable.

---

## Open numbers requiring a spike (guard honored — NOT invented below)

Everything in this list is a number that **cannot** be obtained from published docs or an existing tool's real behavior; each needs a built prototype. Recommend a single **spike ticket: "Out-of-process core re-pricing prototype"**.

1. **Re-priced program-build time inside `typescript-go` for a `no-throw`-shaped workload.** Published: general 8–12× build speedup ([10x TS](https://devblogs.microsoft.com/typescript/typescript-native-port/)) and tsgolint whole-run figures. **Not published:** the isolated program-build ms for our specific project shape (the out-of-process analogue of #3's ~700 ms). → spike.
2. **Subprocess spawn + IPC serialization overhead of the diagnostics bridge, per invocation**, for our rule (paths/config in → diagnostics out). Bounded from above by tsgolint whole-run benchmarks, but the marginal bridge cost is unpublished. → spike.
3. **Cost of reimplementing #3's ~50 ms/2000-fn transitive pass in Go on `typescript-go`'s checker.** Likely faster (native, no boundary on reads), but unmeasured. → spike.
4. **Whether a persistent daemon can amortize the build across editor keystrokes for `no-throw`** (recovering some of the lost reuse benefit for a non-JS core). → spike.
5. **LSP round-trip cost for whole-program transitive type reads** — expected to be disqualifying, but a hard number would require building the round-trip loop. → spike (low priority; shape already argues against it).

**Numbers reasoned from precedent (with stated assumptions), for contrast — not measured for us:** the Go/Rust bridge re-pays the program build (assumption: no daemon; each lint run is cold) and passes only diagnostics (established from tsgolint/oxlint docs, not assumed). The reuse-loss conclusion itself is **not** a spike item — it follows directly from `typescript-go`'s "API: not ready" + the JS-heap nature of `ts.Program`.

---

## Sources (primary)

- Microsoft, *A 10x Faster TypeScript* — https://devblogs.microsoft.com/typescript/typescript-native-port/
- Microsoft, *Announcing TypeScript 7.0* — https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
- `microsoft/typescript-go` README (status: "API: not ready"; LSP in progress; merge-into-TypeScript plan) — https://github.com/microsoft/typescript-go
- `oxc-project/tsgolint` README (benchmarks, "20–40× faster") — https://github.com/oxc-project/tsgolint
- `oxc-project/tsgolint` ARCHITECTURE.md (`go:linkname` shims, shared programs, "not recommended for production use") — https://github.com/oxc-project/tsgolint/blob/main/ARCHITECTURE.md
- `typescript-eslint/tsgolint` README (prototype status; "no plans to take significant development budget away"; "TS AST directly used in rules") — https://github.com/typescript-eslint/tsgolint
- Oxlint, *Type-Aware Preview* (two-binary split; why not a native Rust checker; file-count benchmarks) — https://oxc.rs/blog/2025-08-17-oxlint-type-aware
- Oxlint, *Type-Aware Linting Alpha* (paths/config in → diagnostics out; no type data returned; alpha benchmarks) — https://oxc.rs/blog/2025-12-08-type-aware-alpha.html
- Oxlint docs, *Type-Aware Linting* (separate `oxlint-tsgolint` binary; "tsgolint Builds TypeScript programs using typescript-go") — https://oxc.rs/docs/guide/usage/linter/type-aware.html
- VoidZero, *Announcing Oxlint Type-Aware Linting* — https://voidzero.dev/posts/announcing-oxlint-type-aware-linting
- typescript-eslint, *Typed Linting with Project Service* (same Project Service APIs editors use) — https://typescript-eslint.io/blog/project-service/
- typescript-eslint, *Custom Rules* (`getParserServices(context).program`) — https://typescript-eslint.io/developers/custom-rules
- typescript-eslint, *Typed Linting performance* ("lint time ≈ build time") — https://typescript-eslint.io/troubleshooting/typed-linting/performance/
- napi-rs (framework for Node.js addons in Rust; Node↔Rust FFI; not a TS checker) — https://napi.rs/
- Internal: `research/03-eslint-rule-capability-matrix.md` (in-process baselines: ~700 ms build, ~50 ms/2000 fn inference, `ParserServices` reuse)

# `@no-throw/dogfood`

Maintainer-side tooling for the performance gates. Not published, not a
`nothrow` subcommand, and not part of any package's API.

There are two gates, asking two questions, and they share the seeding.

**Is hybrid inference cheap enough to ship? (#47)** If it is not, the answer is
#4's lever — set the color policy to `declare` and ship pure declare — rather
than a cleverer inference. So every measurement in that gate comes in pairs:
with inference and without. It runs under ESLint, and its findings and
recommendation live in
[`docs/dogfooding-performance-gate.md`](../../docs/dogfooding-performance-gate.md).
Raw output lives in `results/`.

**What does the oxlint adapter cost? (#156)** The first gate's number does not
transfer: under ESLint the rules ride a program typescript-eslint has already
built, and under oxlint there is nothing to ride on, so the adapter builds one
itself. That is a *fixed* cost, and a fixed cost disappears when it is quoted as
a percentage of a large run. The `oxlint-cost` binary measures it directly.
Its findings live in
[`docs/oxlint-adapter-cost.md`](../../docs/oxlint-adapter-cost.md).

## Preparing a target

The target is a checkout outside this repository, with its own dependencies
installed. Nothing here clones or installs it.

```sh
git clone https://github.com/microsoft/TypeScript.git
cd TypeScript && git checkout b465fdbfe175304d9b977da137b2c178ae1091d3 && npm ci
```

On Windows that checkout aborts on the test baselines, whose paths exceed the
legacy limit, and an aborted checkout leaves a tree that looks plausible and is
not the commit — a target nothing here can tell you is wrong. `git config
core.longpaths true` fixes it; excluding `/tests` from a sparse checkout is
faster, and neither gate reads them.

The ESLint gate runs the **target's** ESLint, TypeScript and typescript-eslint,
not the workspace's: the absolute numbers should be the ones that codebase's CI
actually pays, and a delta between arms should be the rules and nothing else.
It writes its arm configs into the target root, marks real functions in the
target's own sources, and restores every file it touched when it is done.

`oxlint-cost` runs the **workspace's** oxlint, because a target need not have
one. What that costs in fidelity it buys back in reach: any project on disk can
be a target, which is what a reader who wants to check the published number
against their own tree needs.

## The arms

Under ESLint:

| arm | what it is |
| --- | --- |
| `baseline` | the target's own ESLint config, untouched |
| `preset` | that config plus `configs.recommended`, dropped in as a consumer would |
| `preset-compat` | the same, with the preset's `@typescript-eslint` registration removed |

`preset` is the arm that says whether the preset installs at all. `preset-compat`
is the one the measurements use where it does not.

Each non-baseline arm runs under both color policies — `hybrid` and, with
`NOTHROW_COLOR_POLICY=declare`, the pure-declare floor.

Under oxlint there are two, and neither is the target's own config: everything
oxlint reports on its own is off in both, so the delta between them is these two
rules and nothing else.

| arm | what it is |
| --- | --- |
| `baseline` | oxlint with its own categories off, and no `jsPlugins` |
| `plugin` | the same, plus `@no-throw/oxlint-plugin` and the two rules |

## Running

Through the root scripts, which carry the heap size a program over a codebase
this size needs:

```sh
pnpm run build
pnpm run dogfood:scc    <target> src/tsconfig-eslint.json src out.json
pnpm run dogfood:cycles <target> typescript src/tsconfig-eslint.json src
pnpm run dogfood:cold   <target> typescript 0,100,500,2000 3 baseline,preset-compat src/compiler
pnpm run dogfood:warm   <target> typescript 5
pnpm run dogfood:oxlint-cost <target> 0,400 5 src/compiler
```

- **`scc`** condenses the target's call graph the way the engine does, and
  reports the size distribution of the groups. The memo unit is the SCC (#30
  §G), so that distribution is what decides whether group-granular invalidation
  is cheap.
- **`cycles`** applies each cycle edit and reports what it did to the group
  containing the anchor function — the evidence that the "split" edit splits and
  the "merge" edit merges.
- **`cold`** is CI-shaped: a fresh process per run, over a sweep of seed counts.
  It interleaves the arms inside each repeat and discards a warm-up per seed
  count, because marking a tree evicts it from the OS cache and arms measured
  minutes apart drift by more than the effect being measured.
- **`warm`** is editor-shaped: one process, one live program, the same file
  edited and re-linted.
- **`oxlint-cost`** is the other host's cold run, over a sweep of seed counts,
  interleaved and warmed the same way. Each seed count is measured twice: once
  over everything, and once over a single file. The single-file run is what
  separates the *fixed* cost — loading TypeScript, and building a program, both
  of which cost the same whether the run is handed one file or a thousand — from
  the per-file one, and the fixed cost is the whole of #156's complaint, because
  it is what a project pays before it has marked anything at all. The single
  file is one holding a mark wherever the run placed any, since a file with none
  never reaches the program and would price the load alone.

  A relative `<target>` is resolved against the directory the command was typed
  in, not against this package.

  `oxlint-cost` also prints how many of the linted files hold a **mark-shaped
  token**, because that count is what the cost turns on: the adapter reads a
  file's text before it decides whether to build a program, so a file with
  nothing mark-shaped in it costs nothing. The test is deliberately loose — a
  `@nothrow` in a sentence trips it — which is why this repository's own sources
  are a poor target for it, and why the number is printed rather than assumed.

## Seeds

Seeds are chosen mechanically — top-level function declarations with a body,
spread evenly through each of the target's seed files — and the mark goes inside
an existing JSDoc block where there is one. Every placement is checked against
`findMarks` before the file is written: a mark that did not bind is work the arm
did not do, and a run that quietly places fewer marks than it reports would
understate the very cost it exists to measure.

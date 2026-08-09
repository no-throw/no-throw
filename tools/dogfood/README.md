# `@no-throw/dogfood`

Maintainer-side tooling for the pre-release performance gate (#47). Not
published, not a `nothrow` subcommand, and not part of any package's API.

The gate asks one question: **is hybrid inference cheap enough to ship?** If it
is not, the answer is #4's lever — set the color policy to `declare` and ship
pure declare — rather than a cleverer inference. So every measurement here comes
in pairs: with inference and without.

The findings and the recommendation live in
[`docs/dogfooding-performance-gate.md`](../../docs/dogfooding-performance-gate.md).
Raw output lives in `results/`.

## Preparing a target

The target is a checkout outside this repository, with its own dependencies
installed. Nothing here clones or installs it.

```sh
git clone https://github.com/microsoft/TypeScript.git
cd TypeScript && git checkout b465fdbfe175304d9b977da137b2c178ae1091d3 && npm ci
```

The harness runs the **target's** ESLint, TypeScript and typescript-eslint, not
the workspace's: the absolute numbers should be the ones that codebase's CI
actually pays, and a delta between arms should be the rules and nothing else.
It writes its arm configs into the target root, marks real functions in the
target's own sources, and restores every file it touched when it is done.

## The arms

| arm | what it is |
| --- | --- |
| `baseline` | the target's own ESLint config, untouched |
| `preset` | that config plus `configs.recommended`, dropped in as a consumer would |
| `preset-compat` | the same, with the preset's `@typescript-eslint` registration removed |

`preset` is the arm that says whether the preset installs at all. `preset-compat`
is the one the measurements use where it does not.

Each non-baseline arm runs under both color policies — `hybrid` and, with
`NOTHROW_COLOR_POLICY=declare`, the pure-declare floor.

## Running

Through the root scripts, which carry the heap size a program over a codebase
this size needs:

```sh
pnpm run build
pnpm run dogfood:scc    <target> src/tsconfig-eslint.json src out.json
pnpm run dogfood:cycles <target> typescript src/tsconfig-eslint.json src
pnpm run dogfood:cold   <target> typescript 0,100,500,2000 3 baseline,preset-compat src/compiler
pnpm run dogfood:warm   <target> typescript 5
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

## Seeds

Seeds are chosen mechanically — top-level function declarations with a body,
spread evenly through each of the target's seed files — and the mark goes inside
an existing JSDoc block where there is one. Every placement is checked against
`findMarks` before the file is written: a mark that did not bind is work the arm
did not do, and a run that quietly places fewer marks than it reports would
understate the very cost it exists to measure.

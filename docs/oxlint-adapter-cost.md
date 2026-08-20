# What the oxlint adapter costs

[#47](https://github.com/no-throw/no-throw/issues/47) priced the rules under
ESLint, and the root README quoted its headline — about 3.1 s added to a 33 s
run — from a *Performance* section that never said which adapter produced it.
[#156](https://github.com/no-throw/no-throw/issues/156) is the report that the
number does not transfer, with measurements: about 6.5 s added to a 35-file
project carrying **no marks at all**, taking a roughly 2 s lint to roughly 9 s.

This is the oxlint adapter's own number, and what was done about it.

> **The fixed cost was real and most of it was avoidable.** The adapter built a
> program for every file it was handed, including files that made no claim it
> could check. Reading a file's text for a mark before deciding is enough to
> skip the whole apparatus, and the engine's own rule already said so:
> *unmarked functions have nothing to enforce.* A project with nothing marked
> now pays the TypeScript load — ~620 ms here — and a text scan per file, and no
> program at all: **3.3× to 4.8× cheaper** than before, depending on the target.
> A project that has marked everything pays what it did, which is the right
> answer for it.
>
> The cost that remains is honest and is now stated per host in the README,
> which is #156's other ask.

The harness is [`tools/dogfood`](../tools/dogfood/README.md)'s `oxlint-cost`
binary.

## Why the ESLint number does not transfer

Under ESLint the rules ride a program typescript-eslint has already built for
its own type-aware rules. The marginal cost of adding `no-escaping-throw` to a
project that already lints type-aware is the walk and nothing else — the program
is in the baseline arm as much as in the treatment arm.

Under oxlint there is nothing to ride on. oxlint hands a JS plugin no type
information, so the adapter finds the `tsconfig.json` above each file and builds
the program itself. Two costs follow, and both are *fixed* rather than
proportional:

- **Loading TypeScript.** The compiler is about ten megabytes of JavaScript and
  the adapter cannot analyze a line without it.
- **Building one program per `tsconfig.json`.** Parsing every file the config
  names, plus every `lib.*.d.ts` it implies, plus everything they import.

A fixed cost quoted as a percentage of a large run disappears. That is exactly
what happened: 3.1 s of 33 s reads as 9%, and the same absolute cost against a
2 s lint reads as a different tool. #156's framing is the right one — *people
reach for oxlint because it finishes in a second or two.*

## What was measured

Two arms, interleaved inside each repeat, median reported. Both run the
workspace's oxlint over the same files with oxlint's own categories off, so the
delta between them is these two rules and nothing else.

| arm | config |
| --- | --- |
| `baseline` | `{ "categories": { "correctness": "off" } }` |
| `plugin` | the same, plus `jsPlugins` and `nothrow/no-escaping-throw`, `nothrow/valid-mark` |

Each seed count is measured twice: over every file, and over a single file. The
single-file run is what separates the fixed cost from the per-file one, since
the adapter loads TypeScript and builds a program whether it is handed one file
or a thousand.

Seeds are real functions in the target's own sources, placed mechanically and
checked against `findMarks` before the file is written — the same rule and the
same check the ESLint gate uses, so the two gates are marking the same thing.

### Machine

| | |
| --- | --- |
| CPU | 12th Gen Intel Core i7-12700H, 20 logical cores |
| memory | 32 GiB |
| OS | Windows 11, 10.0.26200 |
| Node | v22.12.0 |
| oxlint | 1.78.0, the workspace's |

A developer laptop, not an isolated benchmark host — see *Reproducing* for the
one thing still owed.

### The targets

Both are slices of **microsoft/TypeScript** at
`b465fdbfe175304d9b977da137b2c178ae1091d3` — the tree #47 measured, so the two
adapters are priced over the same code. Each slice carries its own
`tsconfig.json`, which is what decides how big a program the adapter builds.

| slice | files linted | lines |
| --- | --- | --- |
| `src/harness` | 38 | 17,650 |
| `src/compiler` | 77 | 192,559 |

`src/harness` is there because #156's shape is a small-project shape — 35 files
in the report, 38 here — and a fixed cost only shows what it is worth as a
proportion of a small run.

One fidelity limit worth naming: the adapter resolves **the workspace's**
TypeScript rather than the target's, so these runs are TypeScript 5.9.3 where
#156 reported 6.0.3, and oxlint 1.78.0 where it reported 1.79.0. What is being
compared is two adapters over one toolchain, which is what the ratios need; an
absolute number on a different toolchain will differ.

## Results

Deltas against the baseline arm, median of five interleaved repeats (seven for
the resampled row). **Read these as shapes, not as constants.** Repeated
invocations on this machine move by up to about ±30%, so a figure is
trustworthy to about one significant digit and the *ratios* are what survive.
The baseline arm is the control and is printed beside each delta for exactly
that reason: where two controls disagree, the deltas beside them are not
comparable and the row says so.

### Before: every file paid for a program

| | `src/harness` | `src/compiler` |
| --- | --- | --- |
| **nothing marked**, whole run | +2.10 s *(control 93 ms)* | +7.31 s *(control 217 ms)* |
| — of which fixed | 1.25 s | 3.01 s |
| — each further file | 23 ms | 57 ms |
| **fully marked** (56 / 273 marks) | +3.11 s *(control 134 ms)* | +17.83 s *(control 225 ms)* |

The first row is #156's complaint reproduced: a project that has marked nothing
pays most of what one that has marked everything pays. On `src/harness` it is
two thirds of it — because the work dominating both was building the program,
and the old adapter built it either way.

### After: a file with no mark costs a regex

| | `src/harness` | `src/compiler` |
| --- | --- | --- |
| **nothing marked**, whole run | **+635 ms** *(control 89 ms)* | **+1.52 s** *(control 227 ms)* |
| — of which fixed | 635 ms | 624 ms |
| — each further file | nothing the run separates | 12 ms |
| **fully marked** (56 / 273 marks) | +2.67 s *(control 91 ms)* | +16.49 s *(control 215 ms)* |

Nothing marked is **3.3× cheaper** on `src/harness` and **4.8× cheaper** on
`src/compiler`, and what is left is almost entirely one thing: loading
TypeScript, which is ~620 ms on this machine and is the floor for a type-aware
plugin the host gives no types to. On `src/harness` the whole-run and
single-file deltas are the same number, which is that floor showing up as the
entire cost.

Fully marked is **unchanged**, and the measurement should not be read as
claiming more: the two controls differ by a third on `src/harness`, so the
14% between +3.11 s and +2.67 s is drift rather than a result. That is the
expected answer — every marked file still builds and walks exactly what it did.
`src/compiler` is the cleaner pair, and it moves 7% for the seven files in
seventy-seven that hold no mark.

That is the shape the fix was aiming for. **You pay for the marks you have**,
and the *fixed* rows say it most directly: before, the fixed cost was ~1.25 s on
`src/harness` whether the project had 0 marks or 56; after, it is 635 ms at 0
and 1.33 s at 56, and the difference between those two is the program build
appearing exactly when something needs it.

## What changed

Three edits, and the first is the one that matters.

**The adapter reads the file's text before it decides to build anything.** The
engine's rule was already *unmarked functions have nothing to enforce* — the
escape walk starts at the marks and a file with none produces no findings, by
construction. The adapter was paying the entrance fee before asking whether
there was anything inside. `mayHoldMark` is that rule read off the raw bytes:
an `@` and the mark's letters, spelled out of the same constant `findMarks`
matches against, so the two cannot drift. It over-approximates on purpose — a
`@nothrow` in a sentence trips it — because the only safe direction for a test
that decides whether to analyze is *yes* when unsure.

The one place that direction had to be argued rather than assumed is worth
recording, because the first version of the scan got it wrong. A JSDoc tag name
is an *identifier*, and an identifier may spell any character as a `\uXXXX`
escape: `/** @\u006eothrow */` reaches the binder as the mark and matches
nothing in the raw text. That is a mark that binds and is never enforced —
the silent no-op the whole design is built to rule out — reachable through a
fast path meant only to save time. Resolving escapes in the scan would be a
second scanner to keep in step with the real one, so the scan instead treats
a backslash inside a tag name as a reason to stop guessing and look properly.
[`mark-with-an-escaped-tag-name`](../conformance/fixtures/mark-with-an-escaped-tag-name)
is the fixture, and it fails against the version of the scan that missed it.

The widening had to be narrowed once. Its first form treated *any* backslash in
a tag name as a reason to look, and that caught a regex literal matching `@link`
followed by `\s` in `src/harness` — real code, costing a whole program on a
project with no marks in it. An identifier admits exactly one escape form, so
the test is `\u` rather than any backslash, and neither slice trips it now.

**Hosting stopped needing a program.** A file that no project holds is owed a
diagnostic naming the config to fix, and that answer is a property of the
`tsconfig.json`, not of a built program: the config's own globbed file list
settles it for every file it names. Only a file the globs *miss* needs a program
to decide, because an import can reach it. So the hosting diagnostics survive
the fast path unchanged, which the conformance suite's hosting probes hold —
including a new one for a file the globs miss and an import reaches, which is
exactly the case the cheap answer must not get wrong.

One thing the fast path has to keep doing on the way past is remember the text
the host handed over. A file with no mark of its own is still a *dependency* of
one that has them, so a program built later in the run has to read the editor's
buffer rather than the disk, or a marked file is analyzed against a stale
version of what it calls into — a missed diagnostic that would depend on the
order files were linted in. Keeping the text costs a map write; comparing it
against disk first would cost a read per file, and there is nothing else to
compare it against until a program exists.

**`analyzeSourceFile` reads its seeds before building a carrier or a resolver.**
This is the same change one layer down, and it is what keeps the two adapters
saying the same thing: without it, the oxlint host would stop raising a
malformed `nothrow.overrides.json` on unmarked files while the ESLint host kept
raising it, and the conformance suite holds the two to one behavior. So the
refusal now lands on the files that actually consult a carrier. A project that
has marked nothing anywhere no longer hears about a broken overrides file from
the linter — `nothrow check` is the tool that answers for carrier hygiene, and
it answers regardless of marks.

### One thing measured and not changed

The adapter parses its program with `setParentNodes: true`. The CLI's program
does not, and matching it looked like a free win — a first measurement suggested
it halved the program build. Measured properly, in fresh processes with the
arms alternated, it is **noise**: 1588/1617, 1621/1952, 2127/1497 ms. The first
number was a warm-cache artifact of measuring the two in one process, in that
order. Parent pointers are load-bearing for `findMarks` before the binder has
run, so the flag stays.

## Reproducing

```sh
git clone https://github.com/microsoft/TypeScript.git ts
cd ts && git checkout b465fdbfe175304d9b977da137b2c178ae1091d3 && npm ci
```

On Windows that checkout aborts on the test baselines, whose paths exceed the
legacy limit, and an aborted checkout leaves a tree that looks plausible and is
not the commit. `git config core.longpaths true` fixes it; excluding `/tests`
from a sparse checkout is faster and this gate never reads them.

```sh
pnpm run build
pnpm run dogfood:oxlint-cost <ts> 0,150 5 src/harness
pnpm run dogfood:oxlint-cost <ts> 0,400 5 src/compiler
```

`<target>` is any project on disk — this gate does not need a target that lints
with oxlint already, because it brings its own oxlint and its own config. A
relative path is resolved against the directory the command was typed in.

**Still owed: a Linux reproduction.** #156 asked for one before the size is
treated as settled, and the two commands above are the whole of what it takes —
every figure in this document comes from them, against a tree pinned by commit.

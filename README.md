<h1 align="center">no-throw</h1>

<p align="center">
  <em>Statically enforce that no <code>throw</code> escapes a function marked <code>@nothrow</code>.</em>
</p>

<p align="center">
  <a href="https://github.com/no-throw/no-throw/actions/workflows/ci.yml"><img src="https://github.com/no-throw/no-throw/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@no-throw/eslint-plugin"><img src="https://img.shields.io/npm/v/@no-throw/eslint-plugin.svg" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/@no-throw/eslint-plugin.svg" alt="MIT license"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#the-rules">Rules</a> ·
  <a href="#what-counts-as-an-escape">What counts as an escape</a> ·
  <a href="#async-one-color-over-the-whole-surface">Async</a> ·
  <a href="#carriers-coloring-code-you-did-not-write">Carriers</a> ·
  <a href="#the-cli">CLI</a>
</p>

---

JavaScript has no checked exceptions and no way to ask whether a function throws.
`no-throw` adds one claim you can make about a function — `/** @nothrow */` — and
enforces it: every path out of that body is checked, and anything that could
transfer control out of it as an exception is reported where it happens.

```ts
/** @nothrow */
export function parse(text: string): unknown {
  return JSON.parse(text); // ← reported: JSON.parse can throw
}

/** @nothrow */
export function parse(text: string): Result<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error }; // ← clean
  }
}
```

The mark is a claim about a body, so it is always verified where the body is
visible. It is never taken on faith and never inferred onto your API for you:
you write it, and CI holds you to it.

## Why

A `throw` is a non-local jump the type system does not model. Nothing in a
signature says whether calling it can unwind your stack, so the only way to find
out is to read the callee, and the callee's callees, forever — and the answer
changes without any signature changing. In practice that means one of two
outcomes: `try`/`catch` scattered defensively over calls that never throw, or a
process that dies in production on a path nobody knew existed.

Type-level `Result` libraries answer this by changing every signature in the
program, which works and is a rewrite. `no-throw` answers it by leaving your
signatures alone and adding a claim beside them:

- **You choose the surface.** Marking is opt-in, function by function. An
  unmarked function is unconstrained, so adoption never has a big-bang step.
- **The claim is whole.** `@nothrow` means *no exception leaves this function* —
  not "no `throw` statement in this body". A call that can throw, an iterator
  that can throw while you consume it, a getter that runs on property access, an
  implicit `toString`, a rejected promise you `await`: all of it is the same
  invariant, and all of it is one rule.
- **Everything is reported where you can act on it.** Every diagnostic names
  what floored, why, and what your outs are, in the message itself — because the
  CI log is the channel that survives into code review.

What it does not do: it will not tell you *which* error a function throws, and
it has no opinion about how you represent failure once you have caught it. It
answers exactly one question, at compile time, for the functions you point it at.

## Requirements

| | |
| --- | --- |
| Node.js | >= 20.11 |
| TypeScript | >= 5.0 < 7.0 |
| ESLint | ^9 or ^10, flat config |
| typescript-eslint | type-aware linting must be on |

Every rule here is type-aware: the analysis runs off the same `ts.Program` your
editor and `tsc` already build.

The ESLint rows are the ESLint host's. The same rules load into oxlint —
`^1.78`, no ESLint and no typescript-eslint installed — and the conformance
suite holds both hosts to the same diagnostics; see [hosting in
oxlint](#hosting-in-oxlint).

## Quick start

### 1. Install the preset

```bash
npm install --save-dev @no-throw/eslint-plugin
```

```js
// eslint.config.mjs
import tseslint from "typescript-eslint";
import nothrow from "@no-throw/eslint-plugin";

export default [
  ...tseslint.config({
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  }),
  nothrow.configs.recommended(tseslint.plugin),
];
```

The preset is a **function taking typescript-eslint's plugin object**, and that
is not ceremony. It registers a plugin under `@typescript-eslint`, and ESLint
refuses a namespace registered twice with two different objects — so it uses the
copy your config already has rather than resolving one of its own. Hand it the
wrong thing and it says so, by name, before ESLint ever sees a config.

The preset turns on `nothrow/no-escaping-throw`, `nothrow/valid-mark` and
`@typescript-eslint/no-floating-promises`, all as errors, and carries its own
`files` scope (`.ts`, `.tsx`, `.mts`, `.cts`). It can sit before or after your
own typescript-eslint config; order is not load-bearing. Everything is an error
because CI is where the guarantee lives — a warning enforces nothing.

Prefer to wire the rules up yourself? They are `nothrow/no-escaping-throw` and
`nothrow/valid-mark`, and neither takes options.

#### Hosting in oxlint

A project that lints with [oxlint](https://oxc.rs) installs the other adapter
and writes the two rules into the config it already has — no ESLint, no
`eslint.config.mjs`, no second lint command:

```bash
npm install --save-dev @no-throw/oxlint-plugin
```

```json
{
  "jsPlugins": ["@no-throw/oxlint-plugin"],
  "rules": {
    "nothrow/no-escaping-throw": "error",
    "nothrow/valid-mark": "error"
  }
}
```

Same rule names, same messages, same suggestions in the language server — the
adapters share one report layer in `@no-throw/core`, and [the conformance
suite](#how-this-is-tested) runs the same fixtures through both binaries.
Everything below this rung reads the same for either host.

Three differences, all host-shaped. The rules are type-aware and oxlint hands
a JS plugin no type information, so the plugin builds your program itself: the
`tsconfig.json` above each file that includes it — the nearest first, then the
ones above, walking past a solution-style config that holds no files — one
program per config. A file no project includes — what the ESLint host surfaces
as a `projectService` parse error — is here a diagnostic naming the
`tsconfig.json` to fix: the same remedy, on the only channel a plugin has. And the preset's third rule is
covered by oxlint itself: its type-aware mode carries
`typescript/no-floating-promises`, so turn that on with `--type-aware` for the
float hygiene the ESLint preset wires up.

`oxlint --fix` never applies a bridge, exactly as `eslint --fix` never does.
oxlint also has `--fix-suggestions`, which applies every offered edit in bulk
— that is accepting every bridge blind, and the reason offers ride the
suggestion channel is so that nothing does that without you typing the flag
that says to.

### 2. Mark your first function

```ts
/** @nothrow */
export function double(value: number): number {
  return value * 2;
}
```

That is the whole syntax. It must be a **JSDoc block comment** immediately on a
declaration whose body — or whose initializer, read through parentheses, `as`
and `satisfies` — is exactly one function literal. `// @nothrow` is not a mark
and `@noThrow` is not a mark; both are reported rather than silently ignored.

Marking one function does not produce a wall of errors on the standard library.
`no-throw` ships a **baseline** for `lib.*.d.ts`, generated from ECMA-262 and
WebIDL and gated by a type-conformant fuzzer, so `Object.keys(config)`,
`text.trim()` and `for…of` over an array are clean without you doing anything.
What is left is the genuinely throwing members, and you get told exactly that:

```text
Call to `JSON.parse` escapes this `@nothrow` function: it is colored `throwing`
by the shipped standard-library baseline, so calling it can throw. Your outs:
bridge this call with `try`/`catch`; or, if it cannot throw, report it against
the shipped standard-library baseline at
https://github.com/no-throw/no-throw/issues — the other three carriers are keyed
by npm package name, and no key in that grammar reaches a `lib.*.d.ts` member.
```

### 3. Coloring code you did not write

Once your own functions are clean, what is left are calls into packages nobody
has colored. A declaration with no visible body that no carrier speaks for
**floors to throwing** — the safe answer — and says so:

```text
Call to `decode` escapes this `@nothrow` function: it is declared without a body
— an ambient declaration, a `.d.ts`, or a value known only by its function type
— and no mark, manifest, overlay, override or baseline entry colors it, so it is
assumed to throw. Your outs, in precedence order: bridge this call with
`try`/`catch`; assert the color in `nothrow.overrides.json`; install or write an
`@no-throw/*` overlay; or, if you own the package, ship a manifest with `nothrow
emit`.
```

The fastest of those is the first-party one. Drop a `nothrow.overrides.json` at
your project root and assert what you know:

```json
{
  "$schema": "https://no-throw.github.io/no-throw/schema/v1/nothrow.overrides.schema.json",
  "version": 1,
  "packages": {
    "flaky": {
      "exports": {
        ".": {
          "safeParse": { "color": "non-throwing", "conditions": [] },
          "boom": { "color": "throwing" }
        }
      }
    }
  }
}
```

See [Carriers](#carriers-coloring-code-you-did-not-write) for the whole chain and
what outranks what.

### 4. Publishing: ship a manifest

If you own the package, do not make your consumers assert anything. Lower your
verified marks into a manifest they read automatically.

The commands live in a **separate package** — the plugin does not depend on it,
because `emit` and `check` are genuinely optional for a consumer who only wants
the rules:

```bash
npm install --save-dev @no-throw/cli
```

```console
$ npx nothrow emit
Wrote nothrow.json: 5 entries across 1 subpath.
```

`nothrow emit` builds a program, re-verifies every mark against its real body,
and writes `nothrow.json` beside your `package.json`, keyed by public export
name. **A mark it cannot verify refuses the whole emit** rather than publishing a
claim that is not true:

```text
Nothing was written: 1 mark cannot be published as it stands.
```

That refusal is what makes a published manifest true by construction rather than
by discipline. Wire the check into `prepublishOnly` and a stale manifest can
never ship:

```json
{
  "scripts": {
    "prepublishOnly": "npm run build && nothrow emit && nothrow emit --check"
  }
}
```

The manifest records SRI hashes of the files it was written for, so a rebuilt
`.js` that changed no declaration is still drift — and `--check` catches it.

## The rules

### `no-escaping-throw`

The invariant, whole and atomic. One rule, because "no exception leaves this
function" is one claim: splitting it into a rule per escape kind would let a
config turn half of it off and keep the name.

It reports at the escape site, never at the mark, and every message is built to
be acted on from a CI log alone — the two-clause floor contract is *what*
escaped, *why*, and *what your outs are*:

```text
Uncaught `throw` escapes this `@nothrow` function.
```

Where the remedy really is a mechanical bridge, the diagnostic **offers an edit**
— `Bridge this with try/catch.` — as a suggestion your editor can apply.

**It is never an autofix.** Not for any rule, not under any option. Wrapping a
call in `try`/`catch` changes what your program does with an error, and `--fix`
over a codebase would silently rewrite it into one that swallows everything and
reports nothing. The suggestion channel asks; the fix channel does not. Where the
way out is something a tool cannot decide — return the error instead of throwing
it, await a returned promise and return a value in its place — nothing is offered
at all, on purpose.

### `valid-mark`

Mark hygiene. A mark that binds to nothing is worse than no mark: it reads as a
guarantee, enforces nothing, and nothing else complains. So every `@nothrow` tag
must bind to a function, and one that cannot is a hard error naming the nearest
valid site.

```text
`@nothrow` binds to nothing on an ambient declaration: there is no body to verify
it against, and an in-source mark is always verified. Assert the color in
`nothrow.overrides.json` instead.
```

It also catches the two near-misses that would otherwise be invisible: a mark in
a `//` line comment, and a misspelling that differs from `@nothrow` only in case
or separators.

## What counts as an escape

An escape site is **any expression that transfers control into a body**. Some you
wrote, some you did not.

**Visible transfers** — a `throw`, a call, a `new`, a tagged template.

**Hidden transfers** — the ones with no call in the syntax, owned through the
static type of the receiver:

| you write | what runs |
| --- | --- |
| `obj.prop` | a getter |
| `obj.prop = v` | a setter |
| `obj.prop += v` | both |
| `` `${obj}` ``, `obj + ""`, `+obj` | `toString` / `valueOf` / `Symbol.toPrimitive` |
| `{ ...obj }`, `const { a } = obj` | every own enumerable getter it reaches |
| `for (const x of xs)` | the iteration protocol |
| `x instanceof C` | `Symbol.hasInstance` |

A property the standard library declares as a plain property is not assumed to be
data — the libs declare real getters that way, so silence is a question with no
answer rather than an answer. The baseline states accessor facts positively, with
independent `get` and `set` colors, and a member it says nothing about floors.

**Bridging.** A `try` block neutralizes escapes inside it, and only inside it: a
callback that runs later is not on that path, and a suggestion will never reach
past one to pretend otherwise. A `catch` or `finally` that itself throws is an
escape like any other.

**Cycles.** Mutual recursion is resolved as an optimistic least fixpoint over
strongly-connected components, so a clean cycle stays clean and one throwing
member colors its whole group.

## Async: one color over the whole surface

A promise is a second channel a `throw` can leave on, and a mark that covered
only the synchronous one would be a guarantee with a hole in it. So `@nothrow`
on a promise-producing function means **it never sync-throws and never rejects**.

That makes the three places a rejection is consumed part of the invariant —
`await`, discard, and `return` — and each says something different:

```ts
/** @nothrow */
export async function load(): Promise<Data | undefined> {
  try {
    return await fetchIt();     // await: the rejection becomes a throw here
  } catch {
    return undefined;
  }
}
```

A **terminal `.catch(h)`** whose handler is non-throwing is the other legal shape,
which is why fire-and-forget has one at all. `@typescript-eslint/no-floating-promises`
is in the preset for the same reason: a discarded promise is a rejection nothing
handles, and Node escalates one to an uncaught exception.

The trap this exists to catch is the bridge that cannot fire:

```ts
/** @nothrow */
export function pretendsToBridge(): void {
  try {
    rejects();                  // async — the catch is not on the rejection's path
  } catch {
    return;
  }
}
```

```text
`rejects()` is `async`, so this `try`/`catch` can never fire: an `async` function
does not throw, it rejects, and a `catch` with no `await` is not on that path.
The promise is discarded here and the call that produced it has a body that was
analyzed and can throw. Write `try { await … } catch` instead, or end the chain
with a `.catch(h)` whose handler is non-throwing.
```

One asymmetry worth knowing: a generator's body is lazy but **its parameter list
is eager**, so an `async function*` can still sync-throw before it ever returns
an iterator. And `@nothrow` on a function returning an iterator covers consuming
it too — `.throw()` always escapes, since a throw cannot be laundered through an
iterator.

## Carriers: coloring code you did not write

A **carrier** is anything that states a color for a declaration whose body this
program cannot see. For a declaration in an npm package there are four, consulted
**per key**, highest first:

| | carrier | who writes it | matched by |
| --- | --- | --- | --- |
| 1 | `nothrow.overrides.json` | you, at your project root | npm package name |
| 2 | `@no-throw/*` overlay | anyone, published to npm | its manifest's `package` field |
| 3 | the package's `nothrow.json` | its author, via `nothrow emit` | the package it ships in |
| 4 | `@nothrow` tags in its `.d.ts` | its author, in source | the declaration itself |

The **shipped baselines** sit outside that order rather than at the bottom of it:
they color `lib.*.d.ts`, every carrier above is keyed by npm package name, and no
key in that grammar reaches a lib member. Nothing competes there, which is also
why a wrong baseline entry is a bug report rather than something you can override.

Below all of it is the **floor**: a declaration nobody colors is throwing. Absence
of a fact always means the strict reading — that is what makes adding a carrier
monotone, and never a way to quietly make a real report disappear.

Two rules keep the chain honest. A **valid `nothrow.json` answers for its whole
package**, so it supersedes any surviving `@nothrow` tags in that package's
`.d.ts` — a partial manifest is a statement about everything, not a set of hints.
And a manifest whose **file hashes no longer match** is ignored entirely, at which
point tags resume and overlays and overrides still stand, because they were never
about that package's bytes.

An overlay is just a package whose `nothrow.json` names its target:

```json
{
  "$schema": "https://no-throw.github.io/no-throw/schema/v1/nothrow.schema.json",
  "version": 1,
  "package": "flaky",
  "exports": {
    ".": {
      "safeParse": { "color": "non-throwing", "conditions": [] },
      "boom": { "color": "throwing" }
    }
  }
}
```

It is matched by that `package` field, never by its own npm name.

### Conditions

Plenty of functions are clean *given* something about what you hand them —
`each(xs, fn)` throws only if `fn` does. That is recorded as a condition on a
parameter position, and discharged at the call site by the argument in hand:

```json
{ "each": { "color": "non-throwing", "conditions": ["param1"] } }
```

A condition demands exactly what a mark promises: **one color over the whole
surface**. An argument satisfies `param1` only if calling it never throws, the
promise it hands back never rejects, and consuming what it hands back never
throws. So a body is free to drive `fn()`'s iterator or `await` its promise
without flooring, and a generator that throws after its first `yield` is
reported where it is *passed*, not where it is consumed.

`conditions: []` is unconditional cleanliness, stated positively. Absence means
maximally conditioned. The path grammar is closed — `param0.member`, `param1[]`,
`param0.@@iterator`, and `param0=undefined` / `param0=nullish` for a hazard
guarded by an early return on an absent argument — so a reader that meets a form
it does not know floors the entry rather than dropping the condition inside it.

## The CLI

```bash
npm install --save-dev @no-throw/cli
```

```
nothrow emit [--project <path>]           lower verified marks into nothrow.json
nothrow emit --check [--project <path>]   fail if the manifest has drifted
nothrow check [--project <path>]          name every carrier entry that colors nothing
nothrow --help, nothrow -h                print the usage
```

`--project` names a `tsconfig.json`, or a directory holding one, and defaults to
the working directory. The manifest is written beside the first `package.json`
above the project — which is where a consumer's walk-up finds it.

Exit codes: **0** wrote, matched or found nothing to refuse · **1** refused,
drifted or coloring nothing · **2** could not run. Exit code and stream are one
fact: a run that succeeded says so on stdout, and a run that did not says so on
stderr.

### Checking your carriers

A carrier entry that colors nothing and a correct one come to the same silence at
the call site, so a typo in `nothrow.overrides.json` is invisible exactly where it
matters. `nothrow check` asks the question a call site cannot:

```console
$ npx nothrow check
flaky → "." → `Flaky#safeParse`
  publishes no symbol at this key
...
```

```text
5 entries checked. 3 reach nothing; 1 names a package this project does not hold.
```

It holds every entry the way the resolver chain holds it — against the same
export surface, and against the package the *declaration* ships in rather than
the one that re-exported it. An entry the **schema** rejects is named too, with
the field that lost it: a misspelled `color` floors that one entry rather than
refusing the file, and a floored entry keys as well as a correct one does, so
nothing about the surface would catch it. One verdict is named and still passes:
a **valid** entry for a package this project does not hold is **inert rather
than wrong**, since a monorepo where one workspace has the dependency and another
does not would otherwise fail over a file that is right.

## The `safely()` pattern

There is no `safely()` package, and there will not be one. It is four lines, it
belongs in your codebase, and it verifies with no special-casing anywhere in the
engine — which is the point:

```ts
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

/** @nothrow */
export function safely<T>(fn: () => T): Result<T> {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** @nothrow */
export function readJson(text: string): Result<unknown> {
  return safely(() => JSON.parse(text)); // clean: the callback is entered inside a bridge
}
```

It enters its callback inside a `try`, so it is unconditionally clean and a
throwing callback is fine. Nothing recognizes it by name.

## Performance

Marking is type-aware linting, and the honest question is what it costs on top of
a typed lint you already run. Measured against **microsoft/TypeScript** — 601
files, 379,646 lines, 12,326 functions, 36,566 call edges — with 1,093 marks
placed:

| | |
| --- | --- |
| CI lint, whole `src` | **3.1 s of 33 s** is inference |
| Editor re-lint after an edit | **~100 ms of ~800 ms** |
| Eleven times the marks | +7% |
| Edits that split or merge a cycle group | no worse than an ordinary body edit |

Inference is a removable layer: with it off, the engine drops to a pure-declare
floor that is strictly more conservative and never less sound. That lever exists
so the answer to a performance wall is "ship declare-only", not "make inference
cleverer" — and the conformance suite runs the entire corpus both ways on every
commit to keep it true.

## Packages

| package | what it is |
| --- | --- |
| [`@no-throw/eslint-plugin`](packages/eslint-plugin) | the ESLint adapter and the preset. Contains no analysis. |
| [`@no-throw/oxlint-plugin`](packages/oxlint-plugin) | the oxlint adapter. Contains no analysis. |
| [`@no-throw/core`](packages/core) | the engine: color resolution, the SCC fixpoint, the escape-site walk, the resolver chain, the baselines, and the report layer both adapters speak. Knows nothing about any linter. |
| [`@no-throw/cli`](packages/cli) | the `nothrow` binary. Builds a program and hands it to the core. |

The four release in lockstep on one version. The seam is deliberate: driving the
same analysis from a standalone checker or another linter means writing an
adapter, not touching the engine — the oxlint plugin is that sentence made
good, and the conformance suite is what holds the two adapters to one behavior.

## How this is tested

Every behavior lands in [`conformance/`](conformance/README.md), and only there.
The observable behavior of this tool is *given a TypeScript project on disk,
which diagnostics appear, where, and with what text* — so nothing in the suite
asserts a color, a memo, an SCC or any other internal.

A fixture is a whole project, not a snippet: its own `tsconfig.json`, its real
dependencies committed to disk as `.d.ts` and `.js` files no build step produces,
its `nothrow.overrides.json`, its config files at the root where `eslint .` will
reach them. Fixtures import nothing from `@no-throw/*` and contain no test
framework. They are what your project looks like.

Diagnostic text is normative, so this README is gated on it: every ` ```text `
block above is a message some fixture asserts, character for character.

The suite then runs the same fixtures through the real `oxlint` binary and
holds both hosts to the same diagnostics — plus what oxlint's output cannot
carry: `--fix` must change nothing, and `--fix-suggestions` must produce
exactly the offer a fixture pins.

```bash
pnpm install && pnpm test
```

## Contributing

Issues and pull requests are welcome at
[github.com/no-throw/no-throw](https://github.com/no-throw/no-throw).

PR titles become commits on `main` and drive releases — prefix with a
Conventional Commits type (`feat:` minor, `fix:`/`perf:` patch, `!` breaking).
See [AGENTS.md](AGENTS.md) and [docs/releasing.md](docs/releasing.md).

Two things worth reading before proposing a change to the analysis: the
[trust-base dials](docs/baseline-dials.md), which decide once and as doctrine
where the baseline's guarantee ends, and the
[performance gate](docs/dogfooding-performance-gate.md).

## License

[MIT](LICENSE).

# no-throw

`no-throw` colors every function **throwing** or **non-throwing** and statically
enforces that no throw escapes a non-throwing one.

Throwing is the default; non-throwing is opt-in. You mark a function
`/** @nothrow */` and the tool holds you to it.

```ts
/** @nothrow */
export function fail(): void {
  throw new Error("boom"); // Uncaught `throw` escapes this `@nothrow` function.
}

/** @nothrow */
export function attempt(): void {
  try {
    throw new Error("boom");
  } catch {
    return; // bridged — the throw became a returned value
  }
}

/** @nothrow */
export function parse(text: string): unknown {
  return JSON.parse(text); // Call to `JSON.parse` escapes this `@nothrow`
                           // function: … Your outs, in precedence order: …
}
```

**The guarantee is *no expected error escapes* — not VM-level totality.** Bugs,
OOM and stack overflow still throw, exactly as `panic!` still panics. What a
mark promises is that the errors your program *expects* — a parse failure, a
validation failure, a missing key — leave the function as returned values
rather than on a channel the language does not check. How they are represented
is entirely the function's own business: `Result`, a tuple, a union, `null`.
`no-throw` never sees it. [What the guarantee rests
on](#what-the-guarantee-rests-on) states the edges in full.

**CI is where the guarantee lives; the editor is feedback.** In an editor, a
diagnostic whose remedy is the bridge offers it as a suggestion — one click
wraps the statement in `try`/`catch`, or in `try { await … } catch` where what
escapes is a rejection. It is never an autofix: a bridge changes what your
program does with an error, so `--fix` must never make that choice for you.

## The adoption ladder

Four rungs, in the order you climb them. The first two are the whole tool; the
third is what you reach for the first time a dependency has no colors; the
fourth is for people who publish.

1. [Install the preset.](#1-install-the-preset)
2. [Mark a seed, and bridge until green.](#2-mark-a-seed-and-bridge-until-green)
3. [Handle a dependency floor.](#3-handle-a-dependency-floor)
4. [Publishing: ship a manifest.](#4-publishing-ship-a-manifest)

### 1. Install the preset

```bash
pnpm add -D @no-throw/eslint-plugin
```

That resolves: `0.1.0` is [on npm](#status). Everything below is what the suite
runs against today.

The rules are type-aware, so typescript-eslint is already a prerequisite: they
need its parser and a project. The preset takes typescript-eslint's **plugin
object**, because it turns on a rule from it:

```js
// eslint.config.js
import nothrow from "@no-throw/eslint-plugin";
import tseslint from "typescript-eslint";

export default [
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true },
    },
  },
  nothrow.configs.recommended(tseslint.plugin),
];
```

That is one call, not a sequence: the preset may sit before or after your own
typescript-eslint config, because flat config merges `plugins` across every
config matching a file and resolves rule names on the merged result. If you
install the individual packages rather than the `typescript-eslint` umbrella,
pass `@typescript-eslint/eslint-plugin` itself — the argument is a plugin, and
the umbrella carries one rather than being one. Pass the wrong object and the
preset says so by name before ESLint starts, which is the point of taking it:
handing the preset *your* copy is what keeps ESLint from ever seeing two
different plugins registered under `@typescript-eslint` and refusing to start.

The preset carries the same `files` scope itself, so it sits at the end of the
array unscoped and `eslint .` is safe: the `eslint.config.js` you just wrote is
never handed to a type-aware rule. Keep the parser block in agreement with it.
TypeScript the preset reaches but the parser does not falls to ESLint's default
parser and crashes the same way; TypeScript the parser reaches that no
`tsconfig.json` includes is a parse error, which is `projectService`'s business
to settle and not ours.

That last one is the first thing a real project meets, so it is worth naming
even though nothing here produces it. The block above matches every TypeScript
file in the tree and `ignores` none of them, so a `vitest.config.ts` your
`tsconfig.json` does not `include` fails to parse before any rule sees a line of
it:

```console
vitest.config.ts
  0:0  error  Parsing error: vitest.config.ts was not found by the project service.
              Consider either including it in the tsconfig.json or including it in allowDefaultProject
```

Settle it the way the parser asks. Either put the file in a `tsconfig.json` —
which is the better answer, because a config file you never typecheck is a
config file nothing checks — or, for the root files you deliberately keep out of
one, name them:

```js
parserOptions: { projectService: { allowDefaultProject: ["*.config.ts"] } },
```

`configs.recommended` is the whole contract, all at `error`:

| rule | what it holds you to |
| --- | --- |
| [`nothrow/no-escaping-throw`](#no-escaping-throw) | the entire invariant — no throw escapes a marked function |
| [`nothrow/valid-mark`](#valid-mark) | every `@nothrow` you write binds to a function |
| `@typescript-eslint/no-floating-promises` | a promise is awaited or handled |

Everything is `error` because a warning enforces nothing, and CI is where the
guarantee lives.

The third one is somebody else's rule, and it is here so that the config you
actually install covers the **float** hole rather than leaving it to a second
thing you have to remember. A promise dropped in statement position by a
*throwing* callee is ours and reported — the invariant would not be
self-contained otherwise. A dropped promise that is perfectly clean is no escape
at all, so nothing of ours has an opinion on it, and it is still a bug worth
catching. That is hygiene past the invariant, which is why it is a separate
rule and why turning it off weakens no guarantee.

#### `no-escaping-throw`

One rule carries the **entire** invariant. An uncaught `throw`, an unbridged
call, a discarded throwing promise and a fake bridge are all this rule, told
apart by `messageId` and **never individually disableable**.

That is deliberate. The one-color guarantee is atomic: a configuration that
turns off "unbridged call" while leaving "uncaught throw" on looks sound in a
config file and enforces half a guarantee in the codebase. There is no
arrangement of these rules in which `@nothrow` means less than it says.

#### `valid-mark`

Annotation hygiene, and separable for exactly that reason: "your mark is dead"
is not the guarantee. It reports a `@nothrow` that binds to nothing — see
[where a mark binds](#where-a-mark-binds) — so a mark you trusted for years is
never a silent no-op.

Neither rule takes options, and there will be none. Overlays are always
discovered, the overrides file is always `nothrow.overrides.json` at your
project root, inference is always on. There is no configuration in which the
guarantee means something different.

### 2. Mark a seed, and bridge until green

A **seed** is a function you marked. Pick one — a leaf, ideally — and mark it:

```ts
/** @nothrow */
export function readConfig(text: string): Config | null {
  return JSON.parse(text) as Config; // reported here
}
```

The mark is enforced against the body, so this errors at the call. Bridge it,
and the throw becomes a returned value — which one is yours to choose:

```ts
/** @nothrow */
export function readConfig(text: string): Config | null {
  try {
    return JSON.parse(text) as Config;
  } catch {
    return null;
  }
}
```

That is the whole loop: mark, read the diagnostics, bridge until green. Nothing
else in the codebase changes color, and nothing else starts erroring.

In particular **you do not have to mark the call tree**. An unmarked function
whose body is visible is inferred, so `readConfig` calling your own `normalize`
is judged on what `normalize` actually does — and if `normalize` can throw, the
report lands at the call in `readConfig`, not inside `normalize`, which never
promised anything. [What gets inferred](#what-gets-inferred) is the detail.

The bridge is a `try` with a `catch`. A `try`/`finally` bridges nothing, a
`catch` that rethrows bridges nothing, and a bridge stops at a nested function
boundary — an arrow inside the `try` runs when its holder calls it, not inside
your `try`. Where what escapes is a rejection rather than a throw, the bridge is
`try { await … } catch`; see [Async](#async).

### 3. Handle a dependency floor

Sooner or later a call has no body to read and nobody has colored it. That
**floors** — the sound default is that it throws — and the diagnostic says so
and names your **outs**:

```text
Call to `decode` escapes this `@nothrow` function: it is declared without a
body — an ambient declaration, a `.d.ts`, or a value known only by its function
type — and no mark, manifest, overlay, override or baseline entry colors it, so
it is assumed to throw. Your outs, in precedence order: bridge this call with
`try`/`catch`; assert the color in `nothrow.overrides.json`; install or write an
`@no-throw/*` overlay; or, if you own the package, ship a manifest with
`nothrow emit`.
```

The outs are in the message rather than behind a docs URL, because the CI log
is the channel that survives into code review, and acting on a floor from that
log alone is the whole contract. Take them in order:

**Bridge it.** If the call really can throw, this is not a floor to work around
— it is a true report, and the bridge is the answer.

**Assert the color in `nothrow.overrides.json`.** If you know it cannot throw,
say so, in one file at your project root. Nothing outranks it, so you are never
blocked on somebody else shipping a fix:

```json
{
  "$schema": "https://no-throw.github.io/no-throw/schema/v1/nothrow.overrides.schema.json",
  "version": 1,
  "packages": {
    "flaky": {
      "exports": {
        ".": { "safeParse": { "color": "non-throwing", "conditions": [] } }
      }
    }
  }
}
```

**Install or write an `@no-throw/*` overlay.** An **overlay** is that same
assertion for one package, published so everyone else gets it too: a
`nothrow.json` with a `package` field naming its target, in a package under the
`@no-throw` scope. Every installed one is discovered automatically, the way
`@types` arrive. It is matched by that `package` field and never by its own npm
name — `@no-throw/lodash` is a convention, not a lookup — so an overlay for a
scoped target needs no escape from npm's flat scopes. The resolver is
version-blind in v1.

**Ship a manifest**, if the package is yours. That is [rung
four](#4-publishing-ship-a-manifest).

Those are the four **carriers** that can answer for a bodyless declaration, and
they are asked in that order, **per key** — a carrier that knows one export
leaves the rest to the ones below it:

| carrier | what it is | who writes it |
| --- | --- | --- |
| `nothrow.overrides.json` | one file at your project root | you |
| an `@no-throw/*` overlay | an installed package of colors | anyone |
| what the package ships | its own `nothrow.json`, else its surviving `@nothrow` tags | its author |
| the **baseline** | colors for TypeScript's own libs, keyed by lib target | us |

Under all four is the floor: unanswered means throwing. The guarantee never
rests on silence.

**A floor over the standard library names two outs, not four.** The top three
carriers are keyed by npm package name — `packages: { <name>: … }` in the
overrides file, the `package` field in an overlay, the manifest a package ships
— and no key in that grammar reaches `String.prototype.slice`. Nobody owns
TypeScript's `lib.*.d.ts` either. So the baseline is the only carrier that can
answer for a lib member, and the message says so rather than sending you at
three doors that do not open:

```text
Call to `JSON.parse` escapes this `@nothrow` function: it is colored `throwing`
by the shipped standard-library baseline, so calling it can throw. Your outs:
bridge this call with `try`/`catch`; or, if it cannot throw, report it against
the shipped standard-library baseline at
https://github.com/no-throw/no-throw/issues — the other three carriers are keyed
by npm package name, and no key in that grammar reaches a `lib.*.d.ts` member.
```

The second out is us because the baseline is the one rung you cannot write. Two
tables ship, by two generators over two specifications, and the message names
the one that owes the answer: `Element#innerHTML` sends you to the DOM baseline,
not the standard-library one. A lib member a baseline is *silent* about says
that instead — it is a floor by absence rather than a color anyone stated — and
[offers no edit](#suggestions-never-fixes).

**A floor over a Node builtin names four outs and no key reaches it either.**
`node:path` and its siblings are not npm packages: they are ambient `declare
module` blocks inside `@types/node`, and [the walk that assigns
keys](#what-a-key-looks-like) starts at a package's entry points. So the module
name is not a package you hold, and the package that declares it publishes
nothing to walk. Both spellings of the key fail, and differently, and `nothrow
check` is what says so:

```text
nothrow.overrides.json
  node:path → "." → `posix.join`
    nothing of `node:path` is in this project, so there is no surface to hold
    this against. Inert rather than wrong.
  @types/node → "." → `posix.join`
    `@types/node` publishes nothing at ".", and nothing at any other subpath.
    The walk from its entry points reached no name a carrier could key, so no
    entry under this package reaches anything.
```

So the bridge is the only out that works over `node:*`, and the same holds for
any dependency whose types arrive as ambient declarations rather than as
exports. Unlike the lib case above, the floor itself does not yet know to say
so: it names all four carriers, three of which have no key to be written under.

Both the overrides file and an overlay are held to [a published
schema](packages/core/schema) — the same file the engine validates them
against, so what your editor accepts and what the tool honors cannot drift
apart. Both may key **interface members** and state **accessor facts** — neither
of which `nothrow emit` will ever write for a package whose source it verified.

#### What a key looks like

A key is a subpath and a **JSDoc namepath**: the name a consumer imports, then
`#` for an instance member and `.` for a static or namespace one. That grammar
is what makes the lodash shape colorable, since `declare const _: LoDashStatic`
publishes no function you could name — the members live on the interface:

```ts
// node_modules/lodashish/index.d.ts
export interface LoDashStatic {
  chunk<T>(array: readonly T[], size: number): T[][];
  detonate(): void;
  version: string;
}

export declare const _: LoDashStatic;
```

```json
{
  "$schema": "https://no-throw.github.io/no-throw/schema/v1/nothrow.schema.json",
  "version": 1,
  "package": "lodashish",
  "exports": {
    ".": {
      "LoDashStatic#chunk": { "color": "non-throwing", "conditions": [] },
      "LoDashStatic#detonate": { "color": "throwing" },
      "LoDashStatic#version": { "accessor": { "get": "throwing", "set": "throwing" } }
    }
  }
}
```

Key the **interface**, not the `const` — `_#chunk` names nothing. A default
export is keyed `default`, and its members hang off that: `default#handle`,
`default.make`. The forms in full:

| key | what it names |
| --- | --- |
| `safeParse` | a published function |
| `default` | the default export |
| `Wrapper#size` | an instance member of a published class or interface |
| `Service.make` | a static member, or a member of a published namespace |
| `Formatter#()` | a call signature |
| `Wrapper#new()` | a construct signature, or a class's own constructor |

The walk that assigns keys starts at the package's entry points and follows
what they publish, so a name no entry point reaches has no key, and a member
whose name is not a plain identifier has none either. Entry points are read from
`exports` where a package has one, and from the legacy `types`/`typings`/`main`
trio where it does not — spelled however its author spelled them, since only
`exports` requires the leading `./`.

The last two rows are worth reading twice, because the obvious guess colors
nothing. A call enters the *signature*, and where a member's type is what
carries that signature the property is not on the way:

```ts
// node_modules/picoish/index.d.ts
export interface Formatter {
  (input: string): string;
}

export interface Colors {
  red: Formatter;
  bold: Formatter;
}

declare const picoish: Colors;
export default picoish;
```

`pc.red(text)` reaches the signature inside `Formatter`, so `Colors#red`,
`default#red` and `red` name something nobody calls, and `Formatter#()` is the
key that colors it — both properties at once, since both are that one
signature. A construct signature and a class's own constructor are keyed
`new()`, and deliberately not `new`: a property may already be called that, and
one key for two members would let an entry written for one color the other.

A package's own manifest is verified against SRI hashes of the files it was
written for. A mismatch floors **that manifest**, names the file that drifted,
and lets the package's surviving `@nothrow` tags resume as its carrier; an
overlay and an override are about a package rather than in it, so neither is
touched.

#### What a key is

The second half of a key is the name **a consumer writes**, read off the
package's published surface rather than off the file a symbol happens to be
declared in. `export { a as b }` is keyed `b`; a class's members are
`Class#member` and its statics `Class.static`; a default export is `default`.

A CommonJS package — `declare const pc: Colors` behind `export =` — is the one
shape where that is not the name in its `.d.ts`. The module *is* the exported
value, so what its type carries are its published names: `pc.red` is keyed
`red`, exactly as `export const red` would have been, and not `Colors#red`.

If a key does not resolve, nothing says so at the call — a wrong key and no key
produce the same floor. That is what [`nothrow
check`](#checking-your-carriers) is for.

#### Checking your carriers

```bash
nothrow check [--project <path>]
```

It reads the same two things the resolver does — your `nothrow.overrides.json`
and every `@no-throw/*` overlay you have installed — and holds every entry in
them against the same export surface the resolver keys against. Entries that
reach a published symbol are counted; entries that reach nothing are named, with
what the package *does* publish at that subpath:

```console
$ nothrow check
nothrow.overrides.json
  picocolors → "." → `Colors#red`
    `picocolors` publishes no symbol at this key, so this entry colors nothing.
    What it publishes at ".": `red`, `bgBlack`, `bgBlackBright`, and 41 more

2 entries checked. 1 reaches nothing.
```

An entry naming a package this project does not hold is reported apart and does
not fail the run: it is inert rather than wrong — a workspace that holds the
dependency and a sibling that does not are both right about the same file. Exit
codes are `0` nothing to refuse, `1` something reached nothing or a carrier is
not being honored, `2` could not run. So an inert entry is named, and still
exits `0`.

A carrier is matched by the package a declaration **ships in**, never by the one
that re-exported it — so an entry written under a barrel package reaches nothing
however right its key looks, and `check` names the package to key it under
instead.

Which package that is is decided by walking up to the first `package.json` that
**names** one. A `package.json` with no `name` — the `{ "type": "module" }` file
a dual-published package drops beside one of its builds — marks a module format
scope rather than a package boundary, so the declarations under it still ship in
the package that names itself, and one entry keyed under that name reaches them
all.

A **malformed or schema-invalid `nothrow.overrides.json` is refused outright**,
and nothing is analyzed until it is fixed or removed. Every other carrier
answers for somebody else's package and may fall through to the rung below when
it cannot be read; this one is yours, and falling through would discard what you
wrote without saying so:

```text
`nothrow.overrides.json` cannot be read — it could not be read as a JSON object — so nothing in it is
being honored. An overrides file that is quietly ignored is the silent no-op the
rest of this design exists to rule out, so nothing is analyzed until it is fixed
or removed
```

A `version` this release cannot read is the one exception: reading forward is
what the field is for, so the rungs below simply answer instead, and `nothrow
check` is where you learn it happened.

### 4. Publishing: ship a manifest

Your marks are verified against your source, and a consumer never sees your
source: `removeComments` strips the tags, and declaration emit erases `async`.
`nothrow emit` writes down what survives that.

```bash
nothrow emit           # lower verified marks into nothrow.json
nothrow emit --check   # fail if the manifest has drifted from the source
```

Run it after your build, from the package root — it reads `tsconfig.json` in
the working directory unless `--project` names another one, and writes
`nothrow.json` beside the first `package.json` above the project, which is
where a consumer's walk-up finds it. What goes in are the marks the engine
verifies, keyed by the name a consumer imports; what comes with them are the
facts the `.d.ts` cannot carry — `async`, the paths a **conditional mark** is
clean given, and SRI hashes of everything the build produced from that source,
which is every body a color was read off.

**Emit refuses what it cannot verify.** A mark whose body escapes, a mark that
binds to nothing, a mark on an accessor — each exits non-zero naming the mark,
and nothing is written. A published manifest is therefore true by construction
rather than by discipline, which is what lets a consumer trust it over your
declarations.

The accessor case is a deliberate asymmetry. A manifest can state an **accessor
fact**, and hand-written overlays need to; emit never does, because declaration
emit preserves `get` and `set` — if you own the source, the accessor is already
in your `.d.ts`, and what a consumer needs is a color you cannot verify for both
halves at once. The same holds for interface members.

Wire **check mode** into the script that publishes, so a manifest cannot go out
stale:

```json
{
  "scripts": {
    "build": "tsc && nothrow emit",
    "prepublishOnly": "nothrow emit --check"
  }
}
```

It recomputes the manifest and compares. A rebuilt `.js` with identical
declarations is drift like any other, because the hash is what your consumers
check. Exit codes are `0` wrote or matched, `1` refused or drifted, `2` could
not run. Running it *before* the build is the last of those rather than the
middle one: with no output to hash, emit stops before it has read a single
mark, and a `1` there would be a verdict on a package nothing looked at.

If you ship `.ts` source or URL imports, you need no manifest at all: your tags
are honored and verified directly, because module resolution reaching source
means nothing is opaque.

## The `safely()` recipe

The wrapper everyone writes. It is a recipe rather than a package, and it
verifies with no help from the engine:

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
export async function safelyAsync<T>(
  fn: () => Promise<T>,
): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}
```

Note the `await` in the async one. Without it the `catch` is a **fake bridge**:
an `async` callee does not throw, it rejects, and a `catch` with nothing awaited
is not on that path. The rule reports that, which is why the recipe is written
out here rather than left to be guessed at.

`fn` floors to throwing inside the body, is entered inside a `try`, and is
therefore neutralized there — so `safely` is unconditionally clean and the
engine needs **zero special-casing** to say so. Nothing here is wrapper
detection; it is the ordinary bridge rule, applied to a parameter.

**It is not a package on purpose.** Shipping one would have to pick the error
representation — `Result`, a tuple, a union, `null` — which is the one thing
this tool leaves to you, and it would be the ecosystem's only runtime
dependency, against the zero-footprint ethos that keeps the mark a comment. Copy
it, name the error type whatever your codebase already calls it, and own it.

## What the guarantee rests on

The mark's promise is bounded, and the bounds are worth knowing before you
adopt.

**The trust base is one sentence:**

> The guarantee is relative to the type system's model of the program. Where
> code lies to the checker — a `Proxy`, an `as` assertion,
> `Object.defineProperty`, a wrong ambient declaration — `no-throw` inherits the
> lie.

That is not a list of holes we chose to leave; it is the boundary of what
static types can say. A `Proxy` is type-identical to its target, so "might this
be a Proxy?" has no static answer for *any* object, and flooring on it would
color nothing. It is the same boundary you already accept when you trust a
dependency's `.d.ts` about its types.

**Two holes are in-model, and both are named**, because a hole you can name is
one you can work around:

- **Stack overflow from unbounded recursion.** A function that recurses forever
  throws a `RangeError` no color predicts. It sits with OOM: a resource
  exhaustion, not an expected error.
- **A promise stored and never awaited.** A promise dropped in statement
  position is a float and is reported. One put in a field and read back later is
  not, because nothing at the storing site is an escape.
  `no-floating-promises` — which the preset turns on beside our rules — has the
  same blind spot exactly, so the two together do not close it.

**Module evaluation is out of scope, and that is a scope statement rather than
a hole.** Import side effects, top-level `await`, `static {}` blocks,
decorators and `extends` expressions all run before any function does. A
function's color is about the function.

## Where a mark binds

`@nothrow` binds where you write it on a **declaration whose own body — or
whose initializer, read through parentheses, `as` and `satisfies` — is exactly
one function literal**. So it binds on a `function` declaration including every
form of `export default`; a single-declarator variable statement; a class
method, constructor, accessor or property field, instance, `static` and
`accessor` alike; and an object-literal method, accessor or function-valued
property. Anywhere else is an error, so a mark that binds to nothing is never a
silent no-op you trust for years.

```ts
class Service {
  /** @nothrow */
  handle = (): void => {}; // binds — the body is right there
}

/** @nothrow */
export default (): void => {}; // binds, and emits under the key `default`

/** @nothrow */
export const alias = handle; // error — the body is not at this declaration
```

The body has to be *at* the declaration, not merely reachable from it, because
otherwise the claim would be written in one file and checked in another. Each
way of missing reports itself: a declaration holding something that is not a
function written there names the declaration; a function with no declaration at
all — one passed straight to a call, or assigned with `o.f = () => {}` — is
told there is nothing to bind to, and is never told to move the mark onto the
function around it, which would be a different claim.

Positions with no body reject the mark outright — `declare`/ambient
declarations, interface members, abstract methods and overload signatures. The
rule already refuses them; what each adds is its own out. On an overloaded
function the mark goes on the implementation signature, which is the thing that
throws. For an ambient declaration, assert the color in
`nothrow.overrides.json` instead: an in-source `@nothrow` means *verified seed*
and nothing else.

The comment form and the spelling are checked before position, for the same
reason. A mark is read only from a JSDoc block comment, so `// @nothrow` and
`/* @nothrow */` are errors rather than nothing; and a tag that is the mark up
to case and separators — `@NoThrow`, `@no-throw` — is an error naming the one
spelling. Further out than that is a different tag and stays silent: `@nothrowx`
is not a guess the tool is entitled to make.

## What gets inferred

Marking one function does not force you to mark its call tree. An unmarked
function whose body is visible is *inferred* — clean when nothing in it can
throw, throwing otherwise — and is never itself held to anything: throwing is
the default, and only a mark is a promise. So a call to an inferred-throwing
function is reported at the call, and nothing inside that function is.

```ts
/** @nothrow */
export function read(text: string): unknown {
  return parse(text); // Call to `parse` escapes this `@nothrow` function: its
}                     // body was analyzed and can throw. …

function parse(text: string): unknown {
  return JSON.parse(text); // not reported — `parse` never promised anything
}
```

Bridge inside `parse` and `read` goes green with no second mark.

Mutual recursion is fine: a cycle contributes paths, not throw sites, so a
recursive walk or parser stays clean. A cycle that reaches a throw anywhere
colors *every* member of it throwing — no member of a cycle is colored before
the whole group resolves.

`new C()` is a call to the constructor's *effective* body: the constructor,
plus the class's field initializers, plus the base-class chain through
`super()`. So a throw in a base class's field initializer is reported at the
`new`, and a `try`/`catch` around the `new` bridges it. Parameter defaults run
on every call and are checked there too — including a generator's, whose
parameter list is eager though its body is lazy.

A callee with no visible body — a `.d.ts` declaration, or one the checker
cannot resolve at all — is the carriers' question rather than the program's,
and [rung three](#3-handle-a-dependency-floor) is where that chain lives.

## Higher-order functions

A function that calls one of its own parameters is not throwing — it is
non-throwing **given** that parameter. That is a **conditional mark**, and the
condition is read off the body rather than declared, so there is no annotation
to keep in sync:

```ts
/** @nothrow */
export function myEach<T>(xs: readonly T[], cb: (t: T) => void): void {
  for (const x of xs) cb(x); // clean given `cb`
}

myEach(users, (u) => remember(u.name));  // fine — `remember` is inferred clean
myEach(users, (u) => JSON.parse(u.raw)); // reported here, at the call
```

Only parameters the body actually *enters* are conditioned. One you merely hand
onward is not, so a registry stays unconditionally clean; one you enter inside a
`try`/`catch` is neutralized there, which is why [`safely()`](#the-safely-recipe)
verifies unaided.

Conditions are **condition paths** — access chains over your own parameters,
not positions. A body calling `repo.save(item)` conditions `repo.save`, so
refactoring a callback into an object parameter does not make your function
unmarkable. And when the argument you pass is itself one of *your* parameters,
the condition **propagates** up to you instead of discharging — which is how a
chain of helpers stays markable all the way down.

A condition is a precondition, exactly like a parameter type: it is discharged
at every call by a **call-site join** of the argument's color, so no caller ever
holds a promise it cannot cash. A path landing on a standard-library member is
discharged against the baseline like any other call, so `f(s: string)` entering
`s.startsWith` is markable *and* callable with whatever string you have — no
subtype of `string` exists to override the member. Where the argument cannot be
resolved — a `let` holding a callback, a function captured by a factory — the
call floors, and the diagnostic names the parameter, where the body enters it,
and your outs.

## Generators

A generator's call and its iterator carry one color between them, and `@nothrow`
covers both: the call is clean **and** consuming what it hands back is clean.

Calling a generator runs no body, so a bare call is not an escape however the
body ends — the escape is wherever the body actually runs. Those are the
**consumption sites**: `for…of`, spread, array destructuring, `.next()`,
`.return()` and `yield*`, and each is reported and bridged there.

```ts
function* lines(): Generator<string> {
  throw "boom";
}

/** @nothrow */
export function count(): number {
  const it = lines(); // fine — nothing has run yet
  let n = 0;
  for (const line of it) n += line.length; // Consuming this iterator escapes …
  return n;
}
```

Which call produced the iterator is read off the syntax: a direct call, or a
`const` initialized by one — the same rule `await` uses. Anything else — a
`let`, a parameter, a property — floors, and the message says which problem it
is. That is also what makes a plain function markable as an iterator producer:
`return inner()` is provable, `return someIterator` is not.

A condition does not stretch to cover it: `@nothrow` given `make` says calling
`make` is clean, and consuming what it hands back is a second promise the
condition has no form for, so that floors too.

`yield` is not a throw site — it can throw only because a consumer called
`.throw()` — and `.throw()` itself always escapes, whatever the iterator makes
of it: a throw cannot be laundered through one.

Iteration over anything else resolves through `[Symbol.iterator]` and the
`next` it hands back, so an in-program iterable is colored by its own bodies
and a builtin one — an array, a `Map`, a string — by its baseline entry.

## Async

`@nothrow` on a promise-producing function — `async` or not — asserts the
whole consumption surface: the call never sync-throws **and** the promise it
hands back never rejects. TypeScript never computes reject-ness, so it rides
our color and nothing else, which is what makes this one mark rather than two.

```ts
async function fetchUser(): Promise<User> {
  throw "boom";
}

/** @nothrow */
export async function greeting(): Promise<string> {
  const user = await fetchUser(); // Awaiting `fetchUser()` escapes this
  return user.name;               // `@nothrow` function: the call that produced
}                                 // it has a body that was analyzed and can …
```

Which call produced an awaited promise is the generators' rule again — a direct
call, or a `const` initialized by one, so starting early and awaiting later
works. Anything else floors with the floor's usual outs, and the message keeps
the two cases apart: a `let` is a refinement not yet made, while a parameter or
a property is unknowable from here.

**The bridge is `try { await … } catch`**, and it is the one that always works,
so nobody has to reason about whether the callee is `async`: where the call *is*
the awaited expression, the `await` answers for both channels. Drop the `await`
and it is no bridge at all but a **fake bridge** — on a visibly-`async` callee
the `catch` can never fire, which gets a diagnostic of its own rather than a
silent green.

```ts
/** @nothrow */
export function pretendsToBridge(): void {
  try {
    fetchUser(); // `fetchUser()` is `async`, so this `try`/`catch` can never
  } catch {      // fire: an `async` function does not throw, it rejects, and a
    return;      // `catch` with no `await` is not on that path. …
  }
}
```

**A discarded promise is an escape.** A visibly-`async` callee cannot
sync-throw, so its bare call is not a sync escape — but a **float**, a promise
dropped in statement position, is one, `void` included, because Node escalates
the unhandled rejection while the caller sees a clean return. A terminal
`.catch(h)` with a non-throwing handler is the sanctioned fire-and-forget, and
a rethrowing handler is simply a throwing `h`:

```ts
/** @nothrow */
export function fireAndForget(): void {
  sendTelemetry().catch(log); // clean — `log` is non-throwing
}
```

Chains fold by the normative table, with handlers read as ordinary functions: an
inline arrow inferred, a reference resolved, an opaque one flooring the link.

| link | non-throwing when |
| --- | --- |
| `f()` | `f` is |
| `X.then(a)` | `X` and `a` are |
| `X.then(a, b)` | `a` and `b` are — `b` discharges `X`'s rejection |
| `X.catch(b)` | `X` is, else `b` is — `b` runs only on a rejection |
| `X.finally(c)` | `X` and `c` are — `finally` discharges nothing |

The fold is syntactic, so a stored partial chain and a dynamic method name
floor. And it describes `Promise.prototype`: a thenable whose `then` has a
visible body is an ordinary call, colored by the body that actually runs, since
folding it would assume semantics the source is right there to contradict.

Handing a promise on is covered too — `return <expr>` folds what that expression
would reject with into the marked function's own promise, implicit arrow bodies
included, so a one-line wrapper cannot launder a rejection.

`for await` resolves through `[Symbol.asyncIterator]`, falling back to the
synchronous member the way the language does, with the same one-color surface as
`for…of`. An `async function*` is exempt from the sync-throw carve-out for the
generators' reason: its body is lazy but its parameter list is eager, so it can
sync-throw where a plain `async` function cannot.

A condition does not stretch here either. `@nothrow` given `produce` says
calling `produce` is clean, not that the promise it hands back never rejects;
and a chain handler reached through a parameter is not something a call site can
discharge. Both floor.

## Calls you did not write

Some expressions run a body with no callee anywhere in the syntax. They are
**escape sites** all the same, and the static type is what finds them.

```ts
class Config {
  get port(): number {
    return Number(process.env["PORT"] ?? throwUnset());
  }
}

/** @nothrow */
export function show(config: Config): string {
  return `${config.port}`; // Reading `config.port` escapes this `@nothrow`
}                          // function: it runs the getter `port`, whose body …
```

**Accessors.** `o.x` and `o.x = v` are calls when the member is really a
getter or setter, and the two carry **independent** colors — so reading a
member that only throws on write costs you nothing. Which half a form consults
is fixed: reads, object destructuring and template interpolation consult
**get**; assignment consults **set**; `+=`, `++`, `--` and the logical
assignments consult **both**; `delete o.x` consults neither. Spread and rest
consult **get over own enumerable members only**, so spreading an object whose
accessors live on its prototype — a class instance, a DOM element — touches
nothing.

**Dynamic keys** narrow, then join. If the checker knows the key's literal
type, exactly those members are touched; otherwise every accessor the type has
is joined. A type whose accessors are all clean stays clean, so a dynamic key
is not a blanket floor.

**Coercion** — `` `${o}` ``, `+o`, `==`, `String(o)`, `instanceof` — resolves
through the static type too. A primitive runs no user code and is clean, which
is the overwhelmingly common case. A type declaring its own `toString`,
`valueOf` or `Symbol.toPrimitive` takes that member's color, and `any` or
`unknown` floors.

## Suggestions, never fixes

A diagnostic whose remedy is a mechanical bridge carries an ESLint suggestion
offering it, shaped by where it lands: `try`/`catch` around the statement, or
`try { await … } catch` where what escapes is a rejection — and, for a `catch`
that cannot fire because nothing is awaited, the missing `await` alone. A
statement a branch or a loop holds without braces is a statement all the same,
so the offer is made there too, and writes the braces along with the bridge.

Where a diagnostic *points* is not where its edit lands. The caret sits on
exactly what the message names, which for a call is the callee: in
`s.trim().slice(0, 3).padEnd(5, "-")` only `padEnd` is throwing, so that is
what is underlined and that is what the message quotes, rather than the whole
chain starting at the `s` nothing is wrong with. How much of the callee is a
name is what decides where the caret starts — `JSON.parse` is one all the way
down and is named in full, while everything left of `padEnd` is a value some
call produced and could not be acted on if it were named. The bridge, when one
is offered, still wraps the statement the escape was written in.

Nothing is ever an ESLint **fix**. Wrapping a call in a bridge changes what the
program does with an error, so the edit is always yours to accept; `--fix` would
otherwise rewrite a codebase into one that swallows everything and reports
nothing.

An offer is made only where the edit is both mechanical and honest. Where the
way out is something else — moving a mark, returning the error instead of
throwing it — there is none. Nor is one made where the wrap would break code
that has nothing to do with the escape, or would reach past a function
boundary: wrapping `const value = risky()` moves the binding out of the scope
that reads it, and wrapping around a callback would be the fake bridge these
rules exist to report. Braces around the statement a label holds change what
the label names, and on a loop — where the label is what `continue` names —
they turn every `continue` under it into a syntax error, so a label gets no
offer either.

Nor is one made where **nobody proved the throw**. An offer endorses the bridge
it writes, and a `lib.*.d.ts` member the baseline says nothing about is throwing
by this tool's assumption — one you cannot change from where you are reading it.
`JSON.parse` keeps its offer, because a baseline entry colored `throwing` is
evidence somebody wrote down; `new Proxy(…)`, which has no entry at all, does
not. Both messages still name the bridge first. Only one presses it.

Wrapping a `return` *is* offered, and it leaves you a compiler error. That is
the point: the bridge is complete, and what is left is the one thing no tool
can decide — what the function returns now that it does not throw.

## Status

This is early, and **`0.1.0` is the first release** — `@no-throw/core`,
`@no-throw/eslint-plugin` and `@no-throw/cli`, on npm at the same version, as
they always will be. What works today: the
mark and its binding rules, the body walk, the `try`/`catch` bridge, the
call-shaped escape sites — a call, `new C()`, `super()`, a tagged template and
a parameter default — **hidden transfers** — accessors, dynamic keys, spread
and coercion — **generators and the sync iteration protocol**, **async** —
`await`, promise chains, floats and `for await` — **hybrid inference** for
unmarked functions whose bodies are visible, **conditional cleanliness** for
higher-order functions, **the whole carrier chain** — a local
`nothrow.overrides.json`, installed `@no-throw/*` overlays, what a dependency
ships, which is its own `nothrow.json` or, absent a valid one, its surviving
`@nothrow` tags, and the **shipped standard-library and DOM baselines** —
**`nothrow emit` and `emit --check`**, and the `configs.recommended` preset.
Everything the chain cannot answer floors to throwing with a diagnostic naming
your outs, and every out it names is a rung you can really reach for — which is
why a floor over a `lib.*.d.ts` member names [two of them rather than
four](#3-handle-a-dependency-floor).

The baselines apply per lib target, so a project with no `dom` in its `lib`
gets no DOM colors, and a member with no entry floors — which is how a
TypeScript release landing ahead of a `@no-throw/core` release stays safe. What
that buys: `Object.keys`, `Object.entries`, `s.trim()`, `s.slice(1, -1)`,
`map.get(k)`, `set.has(x)`, `a.localeCompare(b)`, `for…of` over an array or a
`Map`, `bytes[i]` on a `Uint8Array`, coercing an object that inherits its
`toString`, spreading a DOM element and `el.id` are all green, and
`users.forEach(cb)` is judged on the `cb` you actually passed. What still costs
a bridge is what really throws: `JSON.parse`, `decodeURIComponent`,
`document.createElement`.

Three things are worth knowing before you try it. `Array.prototype.map`,
`filter`, `slice` and `push` ship **throwing**, because `ArraySpeciesCreate`
and `Set` on a frozen array are reachable without lying to the type system and
[the dial sign-off](docs/baseline-dials.md) rules those a hazard; the
`forEach`/`every`/`some`/`find` family is where the **conditional entries** are.
`new Map()` and `new Set()` are green and `new Map(entries)` is not, which is
one entry rather than two: every hazard those constructors have is about the
iterable you pass — driving its iterator, and reading `set`/`add` back off the
object to add entries with — and ECMA-262 returns before all of it when the
argument is absent. The entry states that as a **condition on passing nothing**,
discharged at the call site like any other — and `a.localeCompare(b)` is green
on that same form for a different reason, since everything that can throw there
is ECMA-402's and ECMA-262 reaches that document only through the two positions
it reserves for it, so a locale or an options bag floors and comparing two
strings does not. And writing through an unnarrowable key — `xs[i] = v` —
floors, because the join reaches every accessor the receiver has.

## Packages

Three packages in the `@no-throw` npm scope, versioned in lockstep.

| package | what it is |
| --- | --- |
| [`@no-throw/core`](packages/core) | the engine — color resolution and the escape-site walk |
| [`@no-throw/eslint-plugin`](packages/eslint-plugin) | the ESLint adapter; contains no analysis |
| [`@no-throw/cli`](packages/cli) | the `nothrow` binary; hosts `emit` and `check` |

The engine reads your program through the TypeScript compiler API in process,
and all three packages carry that API across their own surface, so all three
take `typescript` as a peer dependency at `>=5.0.0 <7.0.0`. The ceiling is not
caution: TypeScript 7 ships the compiler as a Go binary and no programmatic API,
so `import ts from "typescript"` still resolves and everything on it is
`undefined`. Left unbounded, that is a peer a consumer satisfies at install and
a `TypeError` at the first rule run — a worse place to find out. TypeScript 6 is
the last release carrying the API, and the suite runs there too.

The plugin takes no peer on typescript-eslint. It never resolves the package —
the preset is handed your plugin object instead — so an entry there would be a
compatibility claim nothing checks, and the common install is the umbrella
`typescript-eslint`, a different package name a peer on the plugin would never
have matched anyway. What the preset needs is stated where it can be enforced:
in the argument.

## Working on it

```bash
pnpm install && pnpm test
```

On Windows, clone with long paths enabled — the conformance fixtures are named
as sentences and nest a `node_modules` under several of them, which is enough to
cross `MAX_PATH` from a deep working directory:

```bash
git -c core.longpaths=true clone https://github.com/no-throw/no-throw.git
```

`git config --global core.longpaths true` sets it once for every repository,
which is the better fix if you work on Windows at all.

`pnpm test` builds, checks that the packages are in lockstep, and runs the
[conformance suite](conformance) — fixture projects on disk paired with the
diagnostics they must produce. Every behavior lands there, the CLI's included:
`nothrow emit` is exercised as a process over producer packages, and what it
writes is read back by a separate consumer project through the ordinary driver.

It also runs the **diagnostics audit**, which is where the message contract
lives:

```bash
pnpm run audit:diagnostics
```

Diagnostic text is normative — the outs a floor names are the whole adoption
cost of this rule, and they only survive if something holds them. The audit
reads the message catalog off the built plugin and the assertions off the
fixtures, and fails when a normative message has no fixture asserting its text,
when a floor names its outs out of precedence order, or when a message that must
not name a nearest valid site starts naming one. A clause with no artifact
behind it is a failure, not a gap to note.

Releases are cut by release-please off the commit log, so a pull request title
carries a [Conventional Commits](https://www.conventionalcommits.org) type —
`feat:`, `fix:`, `fix!:` for a breaking change — ahead of the sentence it would
have had anyway. `feat` and `fix` open a release PR; everything else lands
without moving a version. See [docs/releasing.md](docs/releasing.md), which also
records the schemas' canonical URLs and the SchemaStore submission.

Two peer ranges name what a consumer may install these packages against: the
plugin's `eslint`, and the `typescript` all three share. CI enumerates each
range and holds it to two things per major — the suite passes there, and a
packed tarball installs there under `strict-peer-dependencies=true`. Widening a
claim widens what has to pass.

```bash
pnpm run gate:peer:eslint      # install what would be published, the way a consumer does
pnpm run gate:peer:typescript
```

Both take `-- --self-check`. What makes one install evidence about three
packages is that the range is read from the manifests before anything is
installed: a package that reaches for the compiler and declares no peer, or
declares a different one from its siblings, stops the read rather than
appearing in a claim nothing checks. A consumer installing two of these gets
the intersection of what they declare, so that intersection has to be a range
somebody wrote down.

The suite half needs the workspace resolved on the major under test, which
`node scripts/eslint-peer-matrix.mjs pin 10 && pnpm install --no-frozen-lockfile`
does — `typescript-peer-matrix.mjs` takes the same three commands for the other
range. That edits the root manifest and the lockfile; `git checkout -- package.json
pnpm-lock.yaml` puts them back.

The shipped baselines are generated data, so their correctness is CI over that
data rather than a conformance fixture. Gates guard them, all run in CI and none
needing the specs they were generated from:

```bash
pnpm run gate:fuzz          # attack every shipped clean ES entry with hostile, type-conformant values
pnpm run gate:drift         # symbol-set diff of lib.*.d.ts; newcomers have no entry and floor
pnpm run dom:gate:fuzz      # the same, over the DOM data, in a real DOM
pnpm run dom:gate:deferred  # every callback-taking DOM member is adjudicated sync, queued or floored
pnpm run dom:gate:drift     # symbol-set diff of lib.dom*.d.ts
```

Each takes `-- --self-check`, which plants a failure and requires the gate to
catch it: a gate that cannot fail is not a gate.

Regenerating the data is a maintainer task — see
[`tools/es-baseline`](tools/es-baseline),
[`tools/dom-baseline`](tools/dom-baseline) and the one-off
[dial sign-off](docs/baseline-dials.md).

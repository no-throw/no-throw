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

**CI is where the guarantee lives; the editor is feedback.** In an editor, a
diagnostic whose remedy is the bridge offers it as a suggestion — one click
wraps the statement in `try`/`catch`, or in `try { await … } catch` where what
escapes is a rejection. It is never an autofix: a bridge changes what your
program does with an error, so `--fix` must never make that choice for you.

## Wiring it up

The rules are type-aware, so they need typescript-eslint's parser and a
project:

```js
// eslint.config.js
import nothrow from "@nothrow/eslint-plugin";
import tseslint from "typescript-eslint";

export default [
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true },
    },
  },
  nothrow.configs.recommended,
];
```

The preset carries that same `files` scope itself, so it sits at the end of the
array unscoped and `eslint .` is safe: the `eslint.config.js` you just wrote is
never handed to a type-aware rule. Keep the parser block in agreement with it.
TypeScript the preset reaches but the parser does not falls to ESLint's default
parser and crashes the same way; TypeScript the parser reaches that no
`tsconfig.json` includes is a parse error, which is `projectService`'s business
to settle and not ours.

`configs.recommended` is the whole contract, all at `error`:

| rule | what it holds you to |
| --- | --- |
| `nothrow/no-escaping-throw` | the entire invariant — no throw escapes a marked function |
| `nothrow/valid-mark` | every `@nothrow` you write binds to a function |
| `@typescript-eslint/no-floating-promises` | a promise is awaited or handled |

`@typescript-eslint/eslint-plugin` is a peer dependency of the plugin itself,
not only of the preset — typed linting already requires it. Neither `nothrow`
rule takes options; there is no configuration in which the guarantee means
something different.

## Where a mark binds

`@nothrow` binds on a `function` declaration including `export default`; a
single-declarator variable statement with a function or arrow initializer; a
class method or constructor; an accessor, in a class or an object literal; and
an object-literal method or function-valued property. Anywhere else is an error
naming the nearest valid site, so a mark that binds to nothing is never a silent
no-op you trust for years.

Positions with no body reject the mark outright — `declare`/ambient
declarations, interface members, abstract methods and overload signatures. On an
overloaded function the mark goes on the implementation signature, which is the
thing that throws. For an ambient declaration, assert the color in
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
cannot resolve at all — is the carrier chain's question rather than the
program's, and [the next section](#coloring-code-you-do-not-own) is that chain.
Anything it cannot answer floors to throwing, and the diagnostic says which.

## Coloring code you do not own

Four carriers can answer for a bodyless declaration. They are asked in this
order, **per key** — a rung that knows one export leaves the rest to the rungs
below it:

| rung | what it is | who writes it |
| --- | --- | --- |
| `nothrow.overrides.json` | one file at your project root | you |
| an `@nothrow/*` overlay | an installed package of colors | anyone |
| what the package ships | its own `nothrow.json`, else its surviving `@nothrow` tags | its author |
| the baseline | colors for TypeScript's own libs, keyed by lib target | us |

Under all four is the floor: unanswered means throwing.

**You are never blocked.** Whatever nobody else has colored, you can color
yourself, and nothing outranks you:

```json
{
  "$schema": "https://midnightdesign.github.io/no-throw/nothrow.overrides.schema.json",
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

An **overlay** is that same shape for one package, published so everyone else
gets it too: a `nothrow.json` with a `package` field naming its target, in a
package under the `@nothrow` scope. It is matched by that field and never by
its own npm name — `@nothrow/lodash` is a convention, not a lookup — so an
overlay for a scoped target needs no escape from npm's flat scopes. The
resolver is version-blind in v1.

Both are held to [a published schema](packages/core/schema) — the same file the
engine validates them against, so what your editor accepts and what the tool
honors cannot drift apart. Both may key **interface members** and state
**accessor facts**, so `declare const _: LoDashStatic` is colorable — neither
of which `nothrow emit` will ever write for a package whose source it verified.

A package's own manifest is verified against SRI hashes of the files it was
written for. A mismatch floors **that manifest** and names the file that
drifted; an overlay and an override are about a package rather than in it, so
neither is touched.

## Higher-order functions

A function that calls one of its own parameters is not throwing — it is
non-throwing **given** that parameter. The condition is read off the body, not
declared, so there is no annotation to keep in sync:

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
`try`/`catch` is neutralized there, which is why a `safely()`-style wrapper —
enter the callback inside `try`, return the error as a value — verifies with no
help from the engine.

Conditions are paths, not positions: a body calling `repo.save(item)`
conditions `repo.save`, so refactoring a callback into an object parameter does
not make your function unmarkable. And when the argument you pass is itself one
of *your* parameters, the condition propagates up to you instead of discharging
— which is how a chain of helpers stays markable all the way down.

A condition is a precondition, exactly like a parameter type: it is discharged
at every call, so no caller ever holds a promise it cannot cash. Where the
argument cannot be resolved — a `let`, a function captured by a factory — the
call floors, and the diagnostic names the parameter, where the body enters it,
and your outs.

## Generators

A generator's call and its iterator carry one color between them, and `@nothrow`
covers both: the call is clean **and** consuming what it hands back is clean.

Calling a generator runs no body, so a bare call is not an escape however the
body ends — the escape is wherever the body actually runs. `for…of`, spread,
array destructuring, `.next()`, `.return()` and `yield*` are those places, and
each is reported and bridged there.

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
`next` it hands back, so an in-program iterable is colored by its own bodies.
Builtin iterables are the baseline's to answer and floor until it is wired up.

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
and it is no bridge at all — on a visibly-`async` callee the `catch` can never
fire, which gets a diagnostic of its own rather than a silent green.

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
sync-throw, so its bare call is not a sync escape — but dropping a throwing
promise in statement position is one, `void` included, because Node escalates
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
call sites all the same, and the static type is what finds them.

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

## Publishing a package

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
facts the `.d.ts` cannot carry — `async`, the paths a conditional mark is clean
given, and SRI hashes of everything the build produced from that source, which
is every body a color was read off.

**Emit refuses what it cannot verify.** A mark whose body escapes, a mark that
binds to nothing, a mark on an accessor — each exits non-zero naming the mark,
and nothing is written. A published manifest is therefore true by construction
rather than by discipline, which is what lets a consumer trust it over your
declarations.

The accessor case is a deliberate asymmetry. A manifest can state an accessor's
color, and hand-written overlays need to; emit never does, because declaration
emit preserves `get` and `set` — if you own the source, the accessor is already
in your `.d.ts`, and what a consumer needs is a color you cannot verify for
both halves at once. The same holds for interface members.

Wire `--check` into the script that publishes, so a manifest cannot go out
stale:

```json
{
  "scripts": {
    "prepublishOnly": "tsc && nothrow emit --check"
  }
}
```

It recomputes the manifest and compares. A rebuilt `.js` with identical
declarations is drift like any other, because the hash is what your consumers
check. Exit codes are `0` wrote or matched, `1` refused or drifted, `2` could
not run.

## Status

This is early, and **nothing is published to npm yet**. What works today: the
mark and its binding rules, the body walk, the `try`/`catch` bridge, the
call-shaped escape sites — a call, `new C()`, `super()`, a tagged template and
a parameter default — **hidden transfers** — accessors, dynamic keys, spread
and coercion — **generators and the sync iteration protocol**, **async** —
`await`, promise chains, floats and `for await` — **hybrid inference** for
unmarked functions whose bodies are visible, **conditional cleanliness** for
higher-order functions, **every rung of the carrier chain but the baseline** —
a local `nothrow.overrides.json`, installed `@nothrow/*` overlays, and what a
dependency ships, which is its own `nothrow.json` or, absent a valid one, its
surviving `@nothrow` tags — **`nothrow emit` and `emit --check`**, and the
`configs.recommended` preset. Everything the chain cannot answer floors to
throwing with a diagnostic naming your outs, and every out it names is now a
rung you can really reach for. The ES
standard-library baseline ships as data in `@nothrow/core`,
and so does the DOM baseline, but nothing consults either yet, so every
standard-library and DOM call floors too — `new Error(…)` included, iterating
an array or a `Map` with it, and with them the `map`/`forEach` family, whose
conditional entries are what the call-site join will discharge — and so does
every coercion of an object that inherits its `toString` and `valueOf` rather
than declaring them.

That caveat, not the analysis, is most of what you will see today, and the
ratio is worth knowing before you try it. Marking five pure functions over
in-memory `Map`s — no I/O — in a real project produced 128 errors, of which
about seven were about the program's own code; `for…of` alone accounted for 45
and `Array.prototype.push` for 18. Consulting the baselines is what turns that
around.

Not built yet: the baseline rung. The design is locked and lives in
[the v1 spec](https://github.com/MidnightDesign/no-throw/issues/30).

## Packages

Three packages in the `@nothrow` npm scope, versioned in lockstep.

| package | what it is |
| --- | --- |
| [`@nothrow/core`](packages/core) | the engine — color resolution and the escape-site walk |
| [`@nothrow/eslint-plugin`](packages/eslint-plugin) | the ESLint adapter; contains no analysis |
| [`@nothrow/cli`](packages/cli) | the `nothrow` binary; hosts `emit` |

## Working on it

```bash
pnpm install && pnpm test
```

`pnpm test` builds, checks that the packages are in lockstep, and runs the
[conformance suite](conformance) — fixture projects on disk paired with the
diagnostics they must produce. Every behavior lands there, the CLI's included:
`nothrow emit` is exercised as a process over producer packages, and what it
writes is read back by a separate consumer project through the ordinary driver.

The plugin's `eslint` peer range names the majors a consumer may install it
against. CI enumerates that range and holds it to two things per major: the
suite passes there, and a packed tarball installs there under
`strict-peer-dependencies=true`. Widening the claim widens what has to pass.

```bash
pnpm run gate:peer   # install what would be published, the way a consumer does
```

The suite half needs the workspace resolved on the major under test, which
`node scripts/eslint-peer-matrix.mjs pin 10 && pnpm install --no-frozen-lockfile`
does. That edits the root manifest and the lockfile; `git checkout -- package.json
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

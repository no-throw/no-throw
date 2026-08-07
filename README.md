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

**CI is where the guarantee lives; the editor is feedback.**

## Wiring it up

The rules are type-aware, so they need typescript-eslint's parser and a
project:

```js
// eslint.config.js
import nothrow from "@nothrow/eslint-plugin";
import tseslint from "typescript-eslint";

export default [
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true },
    },
  },
  nothrow.configs.recommended,
];
```

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
cannot resolve at all — floors to throwing, and the diagnostic says which.

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

## Status

This is early, and **nothing is published to npm yet**. What works today: the
mark and its binding rules, the body walk, the `try`/`catch` bridge, the
call-shaped escape sites — a call, `new C()`, `super()`, a tagged template and
a parameter default — **hidden transfers** — accessors, dynamic keys, spread
and coercion — **hybrid inference** for unmarked functions whose bodies are
visible, **conditional cleanliness** for higher-order functions, and the
`configs.recommended` preset. Everything with no body to read floors to
throwing with a diagnostic naming your outs. The ES standard-library baseline
ships as data in `@nothrow/core`, but nothing consults it yet, so every
standard-library call floors too — `new Error(…)` included, and with it the
`map`/`forEach` family, whose conditional entries are what the call-site join
will discharge, and every coercion of an object that inherits its `toString`
and `valueOf` rather than declaring them.

Async, generators, iteration, the carrier chain (manifests, overlays,
overrides), the DOM baseline and `nothrow emit` are not built yet. The design
is locked and lives in
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
diagnostics they must produce. Every behavior lands there.

The shipped standard-library baseline is generated data, so its correctness is
CI over that data rather than a conformance fixture. Two gates guard it, both
run in CI and neither needing the ECMA-262 spec:

```bash
pnpm run gate:fuzz     # attack every shipped clean entry with hostile, type-conformant values
pnpm run gate:drift    # symbol-set diff of lib.*.d.ts; newcomers have no entry and floor
```

Regenerating the data is a maintainer task — see
[`tools/es-baseline`](tools/es-baseline) and the one-off
[dial sign-off](docs/baseline-dials.md).

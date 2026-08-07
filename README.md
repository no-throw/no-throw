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

A callee with no visible body — a `.d.ts` declaration, or one the checker
cannot resolve at all — floors to throwing, and the diagnostic says which.

## Status

This is early, and **nothing is published to npm yet**. What works today: the
mark and its binding rules, the body walk, the `try`/`catch` bridge, calls as
escape sites, **hybrid inference** for unmarked functions whose bodies are
visible, and the `configs.recommended` preset. Everything with no body to read
floors to throwing with a diagnostic naming your outs.

Constructors, async, generators, hidden transfers, the carrier chain
(manifests, overlays, overrides), the standard-library and DOM baseline and
`nothrow emit` are not built yet — so until the baseline lands, every
standard-library call floors. The design is locked and lives in
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

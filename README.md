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

The rule is type-aware, so it needs typescript-eslint's parser and a project:

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
    plugins: { nothrow },
    rules: { "nothrow/no-escaping-throw": "error" },
  },
];
```

`nothrow/no-escaping-throw` carries the whole invariant and takes no options.
There is no configuration in which the guarantee means something different.

## Status

This is early, and **nothing is published to npm yet**. What works today: the
mark, the body walk, the `try`/`catch` bridge, and calls as escape sites
resolved against the **pure-declare floor** — a call is clean only when its
callee carries a mark, and everything else floors to throwing with a diagnostic
naming your outs.

The floor is the sound end of the design, not the destination. Inference for
unmarked bodies, constructors, async, generators, hidden transfers, the carrier
chain (manifests, overlays, overrides), the standard-library and DOM baseline,
the `configs.recommended` preset and `nothrow emit` are not built yet — so until
the baseline lands, every standard-library call floors too. The design is locked
and lives in [the v1 spec](https://github.com/MidnightDesign/no-throw/issues/30).

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

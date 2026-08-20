# `@no-throw/oxlint-plugin`

The oxlint adapter for `no-throw`. It turns findings from
[`@no-throw/core`](../core) into diagnostics and suggestions, and contains no
analysis.

It ships the same two rules as [the ESLint
adapter](../eslint-plugin), under the same names, saying the same words:

```json
{
  "jsPlugins": ["@no-throw/oxlint-plugin"],
  "rules": {
    "nothrow/no-escaping-throw": "error",
    "nothrow/valid-mark": "error"
  }
}
```

The rules are type-aware and oxlint hands a JS plugin no type information, so
the plugin reads your program itself: the `tsconfig.json` above each file that
includes it — the nearest first, then the ones above — one program per config.
A file no project includes is a diagnostic naming the config to fix, never a
silent pass.

Building that program is a cost the ESLint adapter never pays, so it has its own
number rather than sharing that one's: [what the oxlint adapter
costs](../../docs/oxlint-adapter-cost.md). The short version is that **a project
with no marks builds no program** — each file's text is read for a mark first,
and a file that never writes one is not analyzed and does not pay to find that
out — so what the plugin costs before you have marked anything is loading the
TypeScript compiler, once per run.

Two host-specific notes. The preset's third rule has an oxlint counterpart —
enable `typescript/no-floating-promises` with `--type-aware` to cover the same
float hygiene. And `oxlint --fix` never applies a bridge, exactly as `eslint
--fix` never does; `--fix-suggestions` applies every offered bridge in bulk,
which is accepting every bridge blind — the one choice the suggestion channel
exists to leave with you.

The documentation is [the root README](../../README.md) — [hosting in
oxlint](../../README.md#hosting-in-oxlint), what each rule holds you to, and
why an offered bridge is never an autofix.

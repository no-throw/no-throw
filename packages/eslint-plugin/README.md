# `@no-throw/eslint-plugin`

The ESLint adapter for `no-throw`. It turns findings from
[`@no-throw/core`](../core) into diagnostics and suggestions, and contains no
analysis.

It ships `nothrow/no-escaping-throw`, `nothrow/valid-mark` and the
`configs.recommended` preset, which turns both on plus
`@typescript-eslint/no-floating-promises`. The preset is a function taking
typescript-eslint's plugin object — `nothrow.configs.recommended(tseslint.plugin)`
— because it registers that object rather than resolving one of its own.

The documentation is [the root README](../../README.md) — [installing the
preset](../../README.md#1-install-the-preset), what each rule holds you to, and
why an offered bridge is never an autofix.

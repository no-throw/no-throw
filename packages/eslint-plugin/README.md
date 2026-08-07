# `@nothrow/eslint-plugin`

The ESLint adapter for `no-throw`. It translates findings from
[`@nothrow/core`](../core) into ESLint diagnostics and contains no analysis.

`nothrow/no-escaping-throw` carries the entire invariant. Escape kinds are
`messageId`s inside it, never separate rules. `nothrow/valid-mark` is annotation
hygiene alongside it: a `@nothrow` that binds to nothing. Neither takes options,
and `configs.recommended` turns on both plus
`@typescript-eslint/no-floating-promises`.

See the [root README](../../README.md).

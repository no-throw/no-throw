# `@nothrow/eslint-plugin`

The ESLint adapter for `no-throw`. It translates findings from
[`@nothrow/core`](../core) into ESLint diagnostics and suggestions, and contains
no analysis.

`nothrow/no-escaping-throw` carries the entire invariant. Escape kinds are
`messageId`s inside it, never separate rules. `nothrow/valid-mark` is annotation
hygiene alongside it: a `@nothrow` that binds to nothing. Neither takes options,
and `configs.recommended` turns on both plus
`@typescript-eslint/no-floating-promises`.

## Suggestions, never fixes

A diagnostic whose remedy is a mechanical bridge carries an ESLint suggestion
offering it, shaped by where it lands: `try`/`catch` around the statement, or
`try { await … } catch` where what escapes is a rejection — and, for a `catch`
that cannot fire because nothing is awaited, the missing `await` alone.

Nothing here is ever an ESLint **fix**. Wrapping a call in a bridge changes what
the program does with an error, so the edit is always the reader's to accept;
`--fix` would otherwise rewrite a codebase into one that swallows everything and
reports nothing.

An offer is made only where the edit is both mechanical and honest. Where the
way out is something else — moving a mark, returning the error instead of
throwing it — there is none. Nor is one made where the wrap would break the file
or reach past a function boundary: wrapping `const value = risky()` would move
the binding out of the scope that reads it, and wrapping around a callback would
be the fake bridge these rules exist to report.

See the [root README](../../README.md).

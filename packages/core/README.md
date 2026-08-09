# `@no-throw/core`

The `no-throw` analysis engine. It owns color resolution, the SCC fixpoint, the
escape-site walk, the resolver chain and the shipped baseline, and it knows
nothing about ESLint.

Hosts pass in source files and the checker off the `ts.Program` they already
built; the core never builds one.

See the [root README](../../README.md).

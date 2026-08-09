# `@no-throw/core`

The `no-throw` analysis engine: color resolution, the SCC fixpoint, the
escape-site walk, the resolver chain and the shipped baseline. It knows nothing
about ESLint, and hosts pass in the checker off the `ts.Program` they already
built.

The documentation is [the root README](../../README.md).

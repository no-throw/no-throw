# `@nothrow/core`

The `no-throw` analysis engine. It owns color resolution, the escape-site walk,
the resolver chain and the shipped baseline, and it knows nothing about ESLint.

Hosts pass in the `ts.Program` they already built; the core never builds one.

See the [root README](../../README.md).

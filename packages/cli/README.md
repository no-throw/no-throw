# `@no-throw/cli`

The `nothrow` binary. It builds a `ts.Program` and hands it to
[`@no-throw/core`](../core), and contains no analysis: which marks bind, whether
a body escapes, and what a function is clean *given* are the engine's answers.

```bash
nothrow emit [--project <path>]           # lower verified marks into nothrow.json
nothrow emit --check [--project <path>]   # fail if the manifest has drifted
nothrow check [--project <path>]          # name every carrier entry that reaches nothing
nothrow --help                            # print the usage
```

The documentation is [the root README](../../README.md) — [publishing a
manifest](../../README.md#4-publishing-ship-a-manifest) covers what emit
refuses, where the file lands, the exit codes and the `prepublishOnly` posture,
and [checking your carriers](../../README.md#checking-your-carriers) covers what
`check` holds an entry against.

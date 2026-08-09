# `@no-throw/cli`

The `nothrow` binary.

```bash
nothrow emit [--project <path>]           # lower verified marks into nothrow.json
nothrow emit --check [--project <path>]   # fail if the manifest has drifted
```

`--project` names a `tsconfig.json`, or a directory holding one, and defaults
to the working directory. The manifest is written beside the first
`package.json` above the project — pure convention, and where a consumer's
walk-up finds it.

Exit codes: `0` wrote or matched, `1` refused or drifted, `2` could not run.

The CLI builds a `ts.Program` and hands it to `@no-throw/core`. It contains no
analysis: which marks bind, whether a body escapes, and what a function is
clean *given* are the engine's answers, and a second implementation of them
here would be a second guarantee.

See the [root README](../../README.md) for what emit refuses and why, and for
the `prepublishOnly` posture.

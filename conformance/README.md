# The conformance suite

Every behavior of `no-throw` lands here, and only here.

The observable behavior of the tool is: *given a TypeScript project on disk,
which diagnostics appear, where, and with what text.* Nothing in this suite
asserts a color, a memo, an SCC, a resolver's return value or any other
internal — all are reachable through the diagnostics, and all are things the
design reserves the right to replace.

## The suite is data

A fixture is a whole project, not a snippet:

```
fixtures/tsconfig.base.json   what a fixture is compiled as unless it says otherwise
fixtures/<name>/
  tsconfig.json     the project the fixture is analyzed as
  expected.json     the diagnostics it must produce
  src/**/*.ts       the code
```

A fixture's `tsconfig.json` extends the shared base and names its own file set,
so what a fixture overrides is what is load-bearing about it — the `lib` setting
in particular decides which standard-library baseline applies.

Fixtures import nothing from `@nothrow/*` and contain no test-framework
constructs. They are what a user's project looks like.

`expected.json`:

```json
{
  "description": "one line, printed next to the verdict",
  "diagnostics": [
    {
      "file": "src/index.ts",
      "line": 3,
      "column": 3,
      "endLine": 3,
      "endColumn": 27,
      "messageId": "uncaughtThrow",
      "message": "Uncaught `throw` escapes this `@nothrow` function."
    }
  ]
}
```

Positions are 1-based; `endColumn` is one past the last character, matching
ESLint. `message` is optional, and asserting it is mandatory wherever the spec
makes the text normative — a floor diagnostic must name why it floored and what
your outs are, and that contract lives in the text.

Two things the format cannot express yet, both of which the driver turns into a
loud failure rather than a silent drop: an autofix, which no rule may ever offer
because wrapping a call in a bridge changes behavior, and a suggestion, which
rules will offer once there is a bridge edit to suggest.

## The driver is thin, and swappable

`src/driver-eslint.ts` runs a fixture through the real
`@nothrow/eslint-plugin`, over the real typescript-eslint parser, and returns
the diagnostics. It is the only part of the suite that knows a linter exists:
driving the same fixtures through a standalone checker means writing a second
driver, not touching a fixture.

```bash
pnpm run build && pnpm run conformance
```

A failing fixture prints its name, its description, and what it expected
against what it got — enough to act on from the CI log alone.

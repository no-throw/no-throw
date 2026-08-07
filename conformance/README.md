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

Until the standard-library baseline lands, every call into `lib.*.d.ts` floors,
`new Error(…)` among them — so a fixture that wants to be green about something
else keeps clear of `.trim()` and friends and throws a bare value, and one that
wants a floor reaches for `JSON.parse`. Iterating a builtin is the same story:
`for…of` over an array or a `Map` resolves to `lib.es2015.iterable.d.ts` and
floors, so a fixture about something else walks an array by index, and one
about iteration iterates a generator or an in-program iterable.

`expected.json`:

```json
{
  "description": "one line, printed next to the verdict",
  "config": "rules",
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

`config` says how the fixture is wired up, and defaults to `"rules"`: the driver
turns each `nothrow` rule on by name. `"recommended"` installs the shipped
preset instead, so a fixture can assert what a user gets from the config they
actually install, third-party rules in it included.

Two things the format cannot express yet, both of which the driver turns into a
loud failure rather than a silent drop: an autofix, which no rule may ever offer
because wrapping a call in a bridge changes behavior, and a suggestion from a
`nothrow` rule, which they will offer once there is a bridge edit to suggest.
Suggestions from rules the preset merely turns on are ignored — pinning a
dependency's suggestion text here would assert nothing about us.

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

## The suite runs twice

`conformance` runs every fixture under hybrid inference, which is what ships,
and then runs the whole suite again with inference off — #4's rip-out lever,
maintainer-internal and reached through the `NOTHROW_COLOR_POLICY` environment
variable, never through a rule option. The engine reads it whenever it builds a
resolver, which it does per file, so one process can run the suite both ways.

The second pass is not checked against `expected.json`. Its assertion is a
**property**: declare-only must report a **superset** of what the hybrid run
reported. That is "strictly tightening, never unsound" written as something a
machine can check, and it keeps the lever honest without opening the core's API
for testing. Places are compared, not text — declare-only floors exactly where
the hybrid run reads a body, so the reason a diagnostic gives differs there by
design.

A superset property passes vacuously if the lever never moved, so the run also
checks that turning inference off floored *something*. If it did not, the pass
fails rather than reporting a green it did not earn.

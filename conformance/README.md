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
  package.json      where the walk-up stops, for a fixture with dependencies
  nothrow.overrides.json   what the project asserts for itself
  src/**/*.ts       the code
  node_modules/<dep>/
    package.json    its entry points, which are how a manifest key is resolved
    index.d.ts      what the consumer's program actually sees
    index.js        never analyzed, only hashed
    nothrow.json    the colors the package ships
  node_modules/@nothrow/<overlay>/
    package.json    a name deliberately unlike its target's, since nothing reads it
    nothrow.json    the same shape, naming its target in `package`
```

A fixture's `tsconfig.json` extends the shared base and names its own file set,
so what a fixture overrides is what is load-bearing about it — the `lib` setting
in particular decides which standard-library baseline applies.

A fixture that exercises the resolver chain carries a **real dependency on
disk**, committed rather than built: a `.d.ts` and a `.js` that no build step
produces, so what the suite runs is what the repository holds. The `.js` is
there to be hashed, because staleness lives in bodies a `.d.ts` cannot show.
Those bytes are pinned to LF in `.gitattributes` — a checkout that converted
line endings would fail every hash and turn the staleness fixtures into noise.
Tampering is expressed the same way: the file simply differs from what the
manifest recorded.

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

`suggestions` is optional too, and says what the diagnostic offers to do about
itself, in the order offered:

```json
{
  "messageId": "unbridgedCall",
  "suggestions": [
    {
      "desc": "Bridge this with `try`/`catch`.",
      "output": [
        "/** @nothrow */",
        "export function usesRisky(): void {",
        "  try {",
        "    risky();",
        "  } catch {}",
        "}",
        ""
      ]
    }
  ]
}
```

`output` is the whole file the edit produces, one array entry per line — a
suggestion is only correct in place, and a bridge around the wrong statement, or
around a callback that runs later, is the exact mistake these rules report. The
line endings a checkout happens to have are not part of it. An empty
`suggestions` asserts there is no offer, which is how a fixture pins that a
remedy the reader has to write by hand is not offered as an edit; omitting the
key does not constrain the offer at all.

`config` says how the fixture is wired up, and defaults to `"rules"`: the driver
turns each `nothrow` rule on by name. `"recommended"` installs the shipped
preset instead, so a fixture can assert what a user gets from the config they
actually install, third-party rules in it included.

Two properties hold across the whole suite rather than in any one fixture, and
the driver turns a breach of either into a loud failure:

- **No message anywhere carries an autofix.** No rule may ever offer one —
  wrapping a call in a bridge changes behavior — and the check stays
  whole-config on purpose, because `--fix` applies every rule the preset turns
  on and a third party's fixer would be editing under our name.
- **Only a diagnostic whose remedy is a mechanical bridge may offer an edit.**
  The driver holds that list, because it is the spec's claim and not the
  plugin's: an offer on anything else is an offer to silence a true report. A
  `messageId` the suite has not heard of is not on the list, so a new one that
  starts offering edits trips this rather than inheriting the permission.

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

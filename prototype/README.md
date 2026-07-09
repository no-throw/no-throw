# no-throw spike — fixture repo (ticket #6)

> **THROWAWAY.** This exists to answer one question and then be deleted or absorbed.
> It is not the implementation. See [issue #6](https://github.com/MidnightDesign/no-throw/issues/6).

## The question

Does the chosen mechanism — the **hybrid color model** ([#4](https://github.com/MidnightDesign/no-throw/issues/4): mark seeds with `@nothrow`, conservatively infer the rest) carried by the **`@nothrow` JSDoc tag** ([#5](https://github.com/MidnightDesign/no-throw/issues/5)), enforced by a **typescript-eslint rule reusing the host `ts.Program`** ([#10](https://github.com/MidnightDesign/no-throw/issues/10)) — actually work and feel right on the load-bearing cases, before the spec is handed off?

## Run it

```sh
pnpm install
pnpm report   # every function's resolved color + enforcement verdict (the "state" view)
pnpm lint     # the real typescript-eslint rule over the fixtures
```

## Shape

One portable engine, two thin shells (this is the [#10](https://github.com/MidnightDesign/no-throw/issues/10) "core + thin adapters" claim, made concrete):

- `color-engine.mjs` — the portable logic: `isMarked`, `resolveColor` (hybrid), `collectEscapes` (enforcement). No ESLint, no console. **The bit worth keeping.**
- `rules/no-throw.mjs` — a ~30-line typescript-eslint rule; pulls the checker off `ParserServices`, calls the engine, emits reports.
- `report.mjs` — a standalone `ts.Program` driver that prints the color of every function.

## Fixtures (the load-bearing cases)

| File | Case | Expected |
|---|---|---|
| `safe.ts` | non-throwing → non-throwing across a file boundary | pass |
| `bridge.ts` | `try/catch` bridge converts a throw to a value | pass |
| `violation.ts` | bare throwing call + bare `throw` in `@nothrow` code | both flagged |
| `thirdparty.ts` | `JSON.parse` bare vs. bridged | flagged / pass |
| `math.ts` | shared callees; also `double` (inferred non-throwing) & `mustBePositive` (inferred throwing) | — |

Findings: **[NOTES.md](NOTES.md)**.

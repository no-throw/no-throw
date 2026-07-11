# no-throw spike — manifest across a package boundary (ticket #15)

> **THROWAWAY.** This exists to answer one question and then be deleted or absorbed.
> It is not the implementation. See [issue #15](https://github.com/MidnightDesign/no-throw/issues/15).
> Shape note: like the #6 spike this is a fixture + self-checking-report prototype,
> not an interactive one — the question is mechanical ("does the transport work"),
> not a state model to drive by hand.

## The question

Does the **emitted-JSON-manifest transport** ([#5](https://github.com/MidnightDesign/no-throw/issues/5))
actually carry colors across a **real package boundary** — a producer compiled to
`.d.ts` + `.js` with comments stripped, installed into a consumer with its **own
separate `ts.Program`** — and can it carry the **`async` (sync-safe) flag**
([#12](https://github.com/MidnightDesign/no-throw/issues/12)) that `.d.ts` erasure destroys?

## Run it

```sh
pnpm install    # once, in prototype/
pnpm boundary   # emit → install → report (exit 0 = all expectations hold)
```

## Shape

- `producer/` — `@spike/mathkit`: `@nothrow` marks in source; `package.json` has
  `"nothrow": "./nothrow.json"` (the discovery field).
- `emit-manifest.mjs` — the producer build: compile (strip comments, emit `.d.ts`),
  **verify each mark**, lower the survivors + async witnesses into `nothrow.json`.
  A lying mark is **refused** (trust-by-construction).
- `install-dep.mjs` — "publish": copies package.json + dist + nothrow.json into
  `consumer/node_modules/@spike/mathkit`. No source crosses the boundary.
- `consumer/` — its own program; `src/app.ts` holds the fixture seeds.
- `report.mjs` — enforces every seed under three configs: manifest on /
  async flag ignored / no manifest. Expected verdicts are asserted.
- engine: the **same** `../color-engine.mjs` as #6, extended behind its
  color-resolution seam with `opts.resolveOpaque` (injected manifest lookup —
  the engine stays fs-free) and the minimal #12 async rules.

## The load-bearing cases

| Fixture | Shows | manifest | no flag | no manifest |
|---|---|---|---|---|
| `handleConfig` | color crosses the boundary | PASS | PASS | FAIL |
| `handleStrict` / `handleStrictBridged` | absence ⇒ floor; bridge still works | FAIL / PASS | same | same |
| `greet` | non-throwing async dep awaits clean | PASS | PASS | FAIL |
| `flakyAwaitBare` / `flakyAwaitBridged` | `try { await … } catch` is the universal bridge | FAIL / PASS | same | same |
| `fireAndForget` | **the async flag is load-bearing**: `.catch` bridge only sound with the sync-safe witness | **PASS** | **FAIL** | FAIL |
| `fakeBridge` | `try { f() } catch` without `await` bridges nothing (#12 trap) | FAIL | FAIL | FAIL |
| `floatEscape` | Tier-1 float of a throwing async call | FAIL | FAIL | FAIL |
| `trustBadMark` | lying mark refused at emit ⇒ consumer floors it (fail-safe) | FAIL | FAIL | FAIL |

Findings: **[NOTES.md](NOTES.md)** (filled in once the spike has run).

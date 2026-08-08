# TypeScript 7 API probe

Reproduces the measurements in [`../../linter-backends-ts7-oxlint-native.md`](../../linter-backends-ts7-oxlint-native.md).

Both scripts generate their own fixtures and spawn their own `tsgo` API server, so there is nothing to configure.

```bash
npm init -y
npm install @typescript/native-preview@7.0.0-dev.20260707.2
node smoke.mjs
node bench2.mjs
```

The version is pinned deliberately: the API is published under `unstable/` on a dated nightly channel, and the surface is expected to change before the stable 7.1 API lands.

**`smoke.mjs`** — end-to-end feasibility. Loads a project, walks the AST locally, batches a type query across every callee, resolves signatures, and reads the `@nothrow` carrier off each callee symbol via `getJsDocTagsOfSymbol`.

**`bench2.mjs`** — phase-separated cost. Reports program load, AST walk (with request counts, to show the walk issues no IPC), and unbatched vs batched `getTypeAtLocation` across fixture sizes.

Timings in the research doc were taken on Windows 11, Node 22.12. The absolute numbers are machine-dependent; the ratios — 0 requests during the walk, ~0.2 ms per round trip, ~25x for batching — are the load-bearing part.

Not reproduced here: the deep-chain anomaly (500 functions in a transitive call chain loading in 35.7 s). Chasing that is the first task of #81, and it wants its own fixture rather than a flag on this one.

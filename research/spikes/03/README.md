# Spike sources for ticket #3

Throwaway probes backing `research/03-eslint-rule-capability-matrix.md`.

```
npm install
node gen.js        # generate the synthetic call graph (src/big/, gitignored)
node mk_dts.js     # emit pkg/lib.d.ts for the cross-boundary test
node spike.js      # cross-file brand/JSDoc reads, try/catch scoping, await
node spike2.js     # compiled-.d.ts boundary + import-alias JSDoc resolution
node perf.js       # transitive throwing-inference, global memo
node perf2.js      # global vs per-file memo (ESLint invocation model)
node dts_strip.js  # removeComments strips @nothrow from .d.ts
```
Not part of the shipped tool — evidence only.

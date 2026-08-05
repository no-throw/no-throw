# PROTOTYPE — stdlib baseline generation spike

Throwaway. Answers https://github.com/MidnightDesign/no-throw/issues/22 — see [NOTES.md](./NOTES.md)
for the verdict and the numbers.

```sh
sh fetch-spec.sh        # ECMA-262 spec.html (gitignored, ~7.3 MB)
node extract.mjs        # spec → per-builtin throw sites  (out/throw-sites.json)
node lib-members.mjs    # lib.*.d.ts → member inventory   (out/lib-members.json)
node classify.mjs       # join + propose verdicts         (out/proposals.json, out/worklist.md)
node fuzz.mjs           # type-conformant fuzzing         (out/fuzz.json)
```

Run from this directory; `typescript` resolves from `prototype/node_modules`.
Drift check across TypeScript versions:
`TS_MODULE=file:///path/to/other/typescript.js OUT=./out/lib-members-old.json node lib-members.mjs`

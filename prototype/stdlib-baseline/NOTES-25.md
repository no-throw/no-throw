# Spike: how far can automation drive the baseline's human calls down?

**Ticket:** [Drive the baseline's human calls toward zero](https://github.com/MidnightDesign/no-throw/issues/25) ·
**Graduated from:** [Spike generating the standard-library baseline](https://github.com/MidnightDesign/no-throw/issues/22)

> PROTOTYPE — throwaway. Extends the #22 pipeline (`extract.mjs`, `classify2.mjs`, `fuzz2.mjs`).
> Run: `node extract.mjs && node lib-members.mjs && node classify2.mjs && HOSTILE=1 node fuzz2.mjs` (~2.3 s).

## Verdict

**The residue was never judgment — it was missing mechanism, and it goes to 16.**

| | #22 | #25 | |
| --- | --- | --- | --- |
| auto-classified | 543/863 (**63%**) | 847/863 (**98%**) | |
| left for a human | **320 members / 475 sites** | **16 members / 21 sites** | all three remaining families are extractor gaps, not calls |
| fuzz gate, type-conformant | 9 counterexamples | **0** | |
| fuzz gate, hostile-but-conformant | *not run* | **0** | |
| fuzz sensitivity | 47% | **83%** | |
| pipeline runtime | ~1.6 s | ~2.3 s | |

And the genuine human surface is not 16 members but **four doctrine dials**, each decided once
and applied by rule — with their cost now measured rather than guessed.

## What changed, and what each change was worth

### 1. Hazards key on the *condition's shape*, not the abstract op's **name** — 63% → 95%

v1's classifier was a hand-maintained enum of root-op names; 34 ops had no entry, stranding 199
sites and **112 members blocked by nothing else**. But those 34 ops throw for the same handful of
reasons the bucketed ones do. Keying on the **prose of the triggering condition** (`IsCallable(x)
is false`, `x is not an Object`, `IsTypedArrayOutOfBounds(r) is true`, `x < 0`, …) replaced 34
missing entries plus 180 "explicit throw with a value-dependent condition" sites with **~18 shape
rules**, and the residue stopped being a treadmill.

This is also a **soundness** change, not just a coverage one. An op-name enum fails *silently in
the unsafe direction* when a name is misfiled — which is exactly what produced #22's six unsound
`Atomics.*` entries (`ValidateAtomicAccess` filed as a brand check when it also range-checks). A
condition-shape rule reads the range check off the prose and cannot make that mistake.

### 2. The generator must hand over the **whole hazard set** — the single most important fix

v1 stored **one** witness per abstract op (`ownThrows[0]`). That is not merely imprecise, it is
**unsound**: it can hand the reviewer the one cause the declared type discharges and hide the one
it does not. `ArrayBuffer.prototype.transfer` reported its `IsSharedArrayBuffer` brand check
(dischargeable ⇒ proposed *clean*) and hid its detach check — the fuzzer refuted it. Same
mechanism hid `Object.prototype.toLocaleString`'s `Invoke`.

Carrying every root cause (3,971 tracked across 219 throwing ops; 1,456 → **11,230** sites) fixes
it. **This is #22's own recommendation 2 — "the reviewer signs hazards, not verdicts" — turning
out to be a soundness requirement rather than a presentation preference.**

### 3. Threading parameter positions through the call chain — the price of (2)

Expanding to the full hazard set immediately broke operand attribution: every cause at a call site
inherited the same argument text, so `String.prototype.charAt` was reported as throwing "because
of `pos: number`". A root cause is about *the callee's parameter i*; lifting it into the caller
means re-resolving **the expression passed at position i** in the caller's own namespace,
recursively, until the chain ends at the builtin's declared parameter or its receiver.

Without this, the hazard set is sound and useless. With it, `charAt`'s `ToString` hazards all
attribute to `thisValue` — the receiver, declared `String` — and discharge.

Two smaller attribution rules paid for themselves:
- **a declared-primitive operand carries no user code** (its prototype is a builtin; patching
  `String.prototype` is trust base per #14) ⇒ every object-shaped hazard on it is unreachable;
- **rest/array parameters are about their element type** (`...values: number[]` ⇒ `number`).

### 4. Spec aliasing — the last counterexample class, found only by the hostile fuzzer

`%TypedArray%.prototype.toString` has no algorithm: the spec says its value *is*
`%Array.prototype.toString%`. A clause with no `<emu-alg>` looks hazard-free while the aliased
function's hazards apply in full — 11 typed-array members proposed clean, all refuted by a
detached buffer. Resolving the aliasing prose closes it.

### 5. The fuzzer: fidelity down, power up

- **Fidelity fix.** Bare type parameters (`K` in `WeakMap<K extends WeakKey, V>`) were being fuzzed
  with `1` — non-conformant, and it manufactured two false counterexamples. `lib-members.mjs` does
  not record constraints, so the honest move is to **refuse the type** (52 skips, up from 21).
  This is #22's rule holding: refuse to fuzz what you cannot model conformantly.
- **Power.** Adding *hostile but type-conformant* receivers — detached and resize-shrunk buffers, a
  subclass with a throwing `Symbol.species`, `Object.create(null)` — lifted sensitivity from
  **17% → 83%** and is what caught (4). These values break builtins **without lying to the type
  system**, so they are the empirical test of the doctrine dials. Notably: `Proxy` is deliberately
  *not* in the pool, because #14 already puts it in the trust base.

## The four doctrine dials, with their cost measured

These are the only genuine human surface left. Each is one trust-base question, decided once and
applied by rule to ~50–100 members. `hazard` = it throws (sound, less precise); `trust-base` = held
against the type system's model, the same class as `Proxy`/`as`.

| dial | question | default | clean members |
| --- | --- | --- | --- |
| — | *(sound defaults)* | | **219** |
| `detachedBuffer` | is a detached / shrunk buffer under a live view a hazard? | hazard | 281 if trust-base |
| `nullPrototype` | is `Object.create(null)` as a receiver typed `object` a hazard? | hazard | 235 if trust-base |
| `subclassHooks` | is `constructor[Symbol.species]` / `this`-as-constructor a hazard? | hazard | 220 if trust-base |
| `memberCallable` | is a *method of* a declared object param (`Symbol.iterator`, `SetLike.has`) a hazard? | hazard | 219 if trust-base |
| — | *(all four at trust-base — the precision ceiling)* | | **312** |

`proxyTraps` was drafted as a fifth dial and is **not one**: #14 already ruled Proxy traps into the
trust base.

**Every default is forced by standing steer 3**, and the argument is the same in each case: the
hazard is reachable by code that does *not* lie to the type system. `ArrayBuffer.prototype.transfer`
is declared API and nothing in `Int32Array<ArrayBufferLike>` says "still attached". `Object.create(null)`
is typed `any` and assignable to `object`. A subclass with a hostile `Symbol.species` is assignable
to `Array<T>`, and `ArraySpeciesCreate` throws *before* any return-type violation could be called a
lie. `Iterable<T>`'s `[Symbol.iterator]` is a declared member, so it is genuinely user code.

So the dials are not a menu — they are an **amendment to #14's trust base**, whose values doctrine
already fixes. What the measurement buys is knowing the price: **the whole doctrine costs 93
members** (312 → 219), and the honest baseline under it is **219 clean / 625 throwing / 3
conditional** with the gate green.

## What is left, and where it goes

**The 16 residual members are three extractor families, no judgment in any of them:**

1. **Bare `Throw a TypeError exception.` (13)** — `Int8Array`…`Float16Array`, `Function.prototype.toString`.
   The condition lives in a *preceding sibling* step ("if it's a function, return … otherwise throw"),
   not a parent, so parent-context stitching misses it.
2. **Abstract Closures (`Promise.*`, when they surface)** — closure bodies are not indexed as
   algorithms, so their throw sites are invisible.
3. **Guards on values the tracer still calls internal (`Promise`, `FinalizationRegistry`, …)** —
   `Let adder be ? Get(target, "set")` derives from `NewTarget`, which the tracer does not model.

**The limiting factor is no longer classification — it is precision, and it needs the checker.**
The clearest remaining imprecision is `Array.prototype.push` reported as throwing because
`LengthOfArrayLike(obj)` may coerce a Symbol `length`: discharging it requires knowing the *type of
`obj.length` given `obj: Array<T>`* — property-level type resolution this prototype does not have
and `@nothrow/core` does, since it runs inside a live `ts.Program`. **Ported to the real engine,
several of these classes discharge for free.**

**AI adjudication was priced against 320 members and is now moot** — an agent panel to sign 16
members whose failures are all mechanism would adjudicate mechanism bugs, not judgment. Should it
ever be wanted, the #5 blind-panel shape is the precedent; nothing here depends on it.

**Residual human sign-off is one-off, not per-release.** Per release the cost is the symbol-set
diff (#22: ~1 s, no spec) plus the fuzz gate on any newly-proposed-clean entry. The dials are spec
doctrine and are signed once.

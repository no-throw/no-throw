# Spike: can the DOM be baselined from WebIDL?

**Ticket:** [Spike a DOM baseline from WebIDL](https://github.com/MidnightDesign/no-throw/issues/26) ·
**Graduated from:** [Spike generating the standard-library baseline](https://github.com/MidnightDesign/no-throw/issues/22)

> PROTOTYPE — throwaway. Independent of the #22/#25 pipeline; DOM shares no input with ECMA-262.
> Run: `node fetch-specs.mjs` (once, ~471 MB cached) → `node idl.mjs && node lib-dom.mjs && node join.mjs && node extract.mjs && node classify.mjs && node fuzz-page.mjs`,
> then `node serve.mjs` and open `http://localhost:8731/?hostile=1` for the gate. Extraction is ~6.5 s.

## Verdict

**Yes — the same generate-then-review shape works, but nothing about it comes from WebIDL.**
IDL supplies the *symbol set*; every throw fact comes from spec prose, and the empirical gate
matters more here than it did for ECMA-262. DOM ships **~2,277 clean / ~6,284 throwing** out of
**8,561 colourable members** — 27% clean, almost exactly the ES baseline's 25% ([#25](https://github.com/MidnightDesign/no-throw/issues/25): 219/863).

**And the spike found a hole that is not about DOM coverage at all** — see §1. It is the most
important thing here and it changes [#14](https://github.com/MidnightDesign/no-throw/issues/14).

| | ES ([#25](https://github.com/MidnightDesign/no-throw/issues/25)) | DOM (this spike) |
| --- | --- | --- |
| colourable members | 863 | **8,561** |
| auto-classified | 98% | **51.5%** (the rest floor) |
| proposed clean | 219 (25%) | **2,277 (27%)** |
| distinct root causes | 86 | **539 (24 cover 80%)** |
| fuzz sensitivity, benign args | 17% | **0%** |
| fuzz sensitivity, hostile args | 83% | **100%** (7/7 controls) |
| counterexamples, hostile | 0 | **12** |
| pipeline runtime | ~2.3 s | ~6.5 s (+ a one-off 471 MB fetch) |

## 1. The finding that isn't about DOM: TypeScript models 898 accessors as properties

Every WebIDL `attribute` is a getter/setter pair on the prototype. `lib.dom.d.ts` declares
**2,552 of 2,576** of them as `PropertySignature`, not `get`/`set` — 99.1%.

The probe checked the runtime truth for every attribute it could reach a receiver for:

```
declaredProperty_isAccessor: 898
declaredProperty_isDataProp:   0
```

**Not one is a data property.** So [#14](https://github.com/MidnightDesign/no-throw/issues/14)'s hidden-transfer rule — *"`o.x` is a call site when it
resolves to a `get`/`set`, and dynamic keys are clean iff the type declares no accessor members"* —
reads `lib.dom.d.ts`, sees ~no accessors, and concludes that DOM property access is free. It is
not: `input.selectionStart`, `request.result`, and `location.href` are function calls that throw.

This is **not** the trust base. #14 puts *user code that lies to the checker* in the trust base
(`Proxy`, `as`, a wrong ambient decl). Here nothing lies — the declaration is TypeScript's own
first-party lib, shipped with the compiler, and the loss is systematic and enumerable rather than
adversarial. Under steer 3 the answer is available, so it must be given: the **baseline needs a
fact class for "this lib-declared property is really an accessor, colour X"**, and #14's
dynamic-key escape hatch has to consult the baseline, not just the declaration.

Left unaddressed it is a silent unsound hole in first-party data across ~2,500 members — by far
the largest single soundness item either baseline spike has turned up.

## 2. Curated WebIDL carries no throw information whatsoever

Across **329 specs / 7,024 IDL members**, the extended attributes are:

```
569 CEReactions · 381 SameObject · 344 Reflect · 168 NewObject · 73 HTMLConstructor …
extended attributes mentioning throw/error/exception: NONE
```

Not one. The ticket's hope that `@webref/idl` might "carry throw information" is answered: it
carries shapes only. The binding layer's own throw sources are almost all discharged by the
declared TypeScript type anyway — enum conversion (TS ships string-literal unions), missing
required dictionary members (TS ships required props), overload resolution, brand checks — leaving
exactly one structural hazard IDL *can* prove: **`[EnforceRange]`, on 23 members**, where TS
declares `number` and the binding range-checks.

**Gecko's `[Throws]` was not spiked, and should not be an oracle.** Its *presence* is a sound
"throwing" signal; its *absence* is one implementation's behaviour, not the contract, and treating
absence as evidence for clean is the unsafe direction — the same mistake as #22's ECMA-402 blind
spot. Steer 3 settles it without a measurement.

## 3. Bikeshed *is* machine-readable, but its call graph is inferred, not marked

The extractor is the Bikeshed analogue of #22's ecmarkup pass: index every `<dfn id>`, take its
region as far as the next `<dfn>`, read throw sites and outbound `<a href>` links, then take a
transitive closure for each member's **whole hazard set** (#25, normative).

`data-dfn-for` / `data-dfn-type` / `data-lt` give member attribution for free, and 799 specs yield
**53,323 definitions, 8,558 member definitions, 7,090 throw sites in 1,990 definitions**. Root-cause
concentration matches ECMA-262's: **539 distinct causes, 24 of which cover 80% of sites** — a
reviewer still adjudicates rules, not sites.

The structural difference is the one that costs: **ECMA-262 marks calls (`?`/`!`), Bikeshed does
not.** A hyperlink is a call, a cross-reference, or a noun, and nothing in the markup says which.
Reading links naively made the graph useless — median **131 definitions visited per member**,
median hazard set 52, `Element.getAttribute` reported throwing. Three rules brought it to a median
of 4 visited and 11 hazards:

1. **Members are leaves.** Prose links `document.domain` and `attachInternals()` to point at them,
   not to call them. Leaving members in the propagating set made `document.domain` the root cause
   of 1,676 hazards.
2. **Throws are read from a member's own region; a *noun*'s region is read for steps only.**
   Otherwise every concept inherits its neighbours' hazards.
3. **Calls are read from the definitional sentence plus steps.** Not every algorithm is a numbered
   list — *"To append a node to a parent, pre-insert node into parent before null"* is one sentence
   that delegates, and reading only `<ol>`s reported `Node.appendChild` **clean**, a false-clean.

Each of these is a soundness/precision trade made explicit rather than discovered late.

## 4. The gate is not a formality here — it is the primary evidence

Sensitivity, measured against 15 hand-signed known-throwing members:

| argument pool | sensitivity | counterexamples on the proposed-clean set |
| --- | --- | --- |
| benign, type-conformant (`'a'`, `1`) | **0% (0/7 probed)** | 9 |
| hostile, still type-conformant | **100% (7/7 probed)** | **12** |

The benign run refutes #22's baseline framing even harder than #25 did: **a benign fuzzer proves
nothing at all about the DOM** — zero of the controls fell. What makes it bite is #25's hostile
pool, ported: `''`, `'!'`, `'<x>'`, `-1`, `0`, `2147483648`, `NaN`, plus receivers/arguments that
are hostile *without lying to the type system* — an ancestor node (cycle), a detached node, a node
from a foreign document. The 6 controls it *refuses* are refused for the right reason (`Node
appendChild<T extends Node>(node: T)` — a bare type parameter, #25's rule holding).

Three extractor bugs were found only by the gate, and two are generalisable:

- **Passive voice.** WebIDL-era specs write *"An `IndexSizeError` exception MUST be thrown if …"* —
  117 such statements in Web Audio alone — and the extractor only matched active `throw`.
- **The exception name precedes the verb in passive voice.** Looking only forward from the verb
  found no name and discarded the site. Fixing both took counterexamples 17 → 12.
- **Alias definitions truncate a region to nothing.** `dom#dom-element-matches` has *zero* links
  and zero throw sites because `webkitMatchesSelector`'s alias `<dfn>` immediately follows it and
  ends the region before the algorithm starts. This is #25's spec-aliasing finding recurring in a
  different markup language, and again **only the hostile fuzzer found it**.

## 5. What did *not* turn out to be the problem

Worth recording because it was the leading hypothesis. **A third of cross-spec links (35,235 of
106,238) leave the IDL-bearing corpus** — 10,688 into Infra, plus Selectors, CSS, ECMAScript — and
Selectors is exactly where `Element.matches`'s `SyntaxError` is defined. That looked like #22's
ECMA-402 blind spot repeating.

It isn't. Closing the corpus (329 → **799 specs**, 137 MB → 471 MB) moved member coverage only
50.4% → 51.5% and left the counterexample count **unchanged at 12**. The binding constraint is
*attribution and reach*, not coverage: `Element.matches` is still clean with Selectors cached,
because its region was already empty (§4). **Fetch the closed corpus anyway** — it is a one-off
cost, it is needed for the callee graph to be honest, and the alternative is a blind spot you
cannot see — but do not expect it to buy precision.

## 6. Where it lands, and what is still floored

Same rung as the ES baseline: **engine data in `@nothrow/core`, keyed by lib target `dom`.**
DOM has no `lib.esXXXX` rhythm, but it does not need one — `lib.dom.d.ts` is versioned by the
TypeScript release, which is the key the ES baseline already uses, and #22's drift alarm
(symbol-set diff, no spec needed) works unchanged.

**Floored, deliberately:**

- **48.5% of IDL-backed members have no member definition in prose** — reflected IDL attributes
  (`ARIAMixin`'s 52), `CSSStyleDeclaration`'s 507 generated CSS-property attributes, and specs
  that predate Bikeshed's dfn conventions (WebGL: 15 `<dfn>`s, zero `data-dfn-for`, ~1,150
  members). They floor to throwing and cost nothing in soundness.
- **Deferred invocation** (`addEventListener`, `requestAnimationFrame`) needs the same explicit
  relaxation entries [#21](https://github.com/MidnightDesign/no-throw/issues/21) gave `setTimeout`, or `try { addEventListener(risky) } catch {}` is a
  reachable fake bridge. The IDL pass already isolates the set: **63 callback-taking members**.
- **1,202 proposed-clean members were never probed** for want of a constructible receiver
  (pool = 293 interfaces). Unprobed is not refuted; per #22, silence proves nothing, so these ship
  on extractor evidence alone and are the obvious place for the next counterexample to hide.

## 7. Recommendations

1. **Ship the DOM baseline; do not floor it.** 27% clean at the same precision as ES, generated,
   with a gate that has 100% sensitivity on its control set.
2. **The accessor fact class is a spec change, not an implementation detail** (§1). It amends #14
   and touches [#17](https://github.com/MidnightDesign/no-throw/issues/17)'s wire format the same way the invoked-parameter-positions fact did.
3. **The hostile fuzzer is the deliverable, not the extractor.** Sensitivity 0% → 100% is the whole
   difference between a gate and a formality, and every mechanism bug in §4 came from it.
4. **Port the generator into `@nothrow/core`** alongside the ES one, per #25's terminal finding —
   the DOM's floored 48.5% includes cases a live `ts.Program` can discharge, and the accessor fact
   *must* be produced against the real declarations.

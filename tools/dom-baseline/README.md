# `@no-throw/dom-baseline-tools`

Maintainer-side tooling. Not published, not a `nothrow` subcommand. It generates
the DOM baseline shipped as engine data in `@no-throw/core` under the `dom` lib
key, and hosts the three CI gates that keep that data maintainable.

It is a port of the ES pipeline, and the shape is the same — extract, classify
against a live `ts.Program`, gate, emit. What changes is the source: **WebIDL
contributes nothing but the symbol set**, and every throw fact comes from spec
prose.

## Generating

```sh
pnpm --filter @no-throw/dom-baseline-tools run fetch-specs   # ~420 MB, cached
pnpm --filter @no-throw/dom-baseline-tools run fetch-gecko   # ~1.4 MB, cached
pnpm run dom:generate
```

Writes `packages/core/baseline-data/dom.json` (the baseline) and
`dom.symbols.json` (the symbol set it was generated from, for the drift gate),
plus `deferred-worklist.json` here. Only generation needs the corpora; all three
gates run over the generated data.

The pipeline:

1. **WebIDL, for the symbol set only.** Across 329 specs, not one extended
   attribute mentions throwing — the generator prints that count every run, and
   it is `0`. IDL carries shapes. The one structural throw fact it *can* prove
   is `[EnforceRange]`, which the classifier records as a throwing site because
   TypeScript declares the parameter `number` and `number` bounds nothing.
2. **Prose is the source.** Bikeshed's `data-dfn-for`/`data-dfn-type`/`data-lt`
   give member attribution free. The graph they form is read under the three
   rules #26 established — members are leaves; throws count from a member's own
   region or a noun's steps only; calls count from the definitional sentence
   plus the steps — which take a naive median of 131 definitions visited per
   member down to a median of 10.
3. **Gecko's `[Throws]` is a one-way oracle.** Presence is a sound *throwing*
   signal and adds a hazard site. Absence is one implementation's behavior and
   is never read at all: there is no function in `gecko.ts` that answers "is it
   clean", because that answer would be unsound.
4. **Classification** keys on the **shape of the throw condition**, never on the
   name of the definition it is written in — #25 made that a soundness
   requirement, since a name-keyed enum fails silently in the unsafe direction.
   Discharge runs against a live `ts.Program`: a condition that names an IDL
   argument resolves to the declared TypeScript type at that position, and a
   condition that names nothing stays reachable.
5. **Accessor facts** from three oracles (§ below), then **the deferred probe**,
   then **the gate** — and only then the entries, so an unprobed clean claim
   never reaches the data.

## The accessor fact

The largest soundness item either baseline spike turned up. `lib.dom.d.ts`
declares 2,552 of 2,576 WebIDL attributes as plain `PropertySignature`, and a
browser probe found 898 of them to be real accessors and **none** to be data
properties — so #14's hidden-transfer rule, read against the declaration alone,
concludes DOM property access is free while `input.selectionStart`,
`request.result` and `location.href` are getter calls that throw.

Declaration shape is therefore not an oracle. Three others are, combined in the
safe direction — any of them saying accessor makes it one:

1. the WebIDL kind (`attribute` is an accessor, `const` is data);
2. `getOwnPropertyDescriptor` on a live receiver, up the prototype chain;
3. the structural rules, for the generated parts the first two are silent on —
   WebGL's constant tables, CSSOM's ~500 generated CSS-property attributes, and
   TypeScript's invented `*EventMap`/`*TagNameMap` interfaces.

Get and set carry independent colors (#29 §1), read off the position of the
"setter steps" heading in the attribute's own region and narrowed through the
call graph. **`set` is never clean**: there is no write probe, because assigning
to a shared receiver would corrupt every later probe, and an unprobed clean
claim floors.

Safe members carry a positive `accessor: false` record, because absence must
keep meaning floor.

## The gates

```sh
pnpm run dom:gate:fuzz
pnpm run dom:gate:fuzz -- --self-check
pnpm run dom:gate:deferred
pnpm run dom:gate:deferred -- --self-check
pnpm run dom:gate:drift
pnpm run dom:gate:drift -- --self-check
```

**The hostile fuzz gate.** Every proposed-clean entry faces a type-conformant
but hostile refutation attempt. #26 measured what makes it bite: benign
arguments refuted **0 of 7** hand-signed controls, the hostile pool refuted
**7 of 7**. The pool is `''`, `'!'`, `'<x>'`, `-1`, `2147483648`, `NaN`, plus
receivers and arguments that are hostile without lying to the type system — an
ancestor node (a cycle), a detached node, a node from a foreign document.
Hostile values come **first**, because the budget is spent round-robin across a
member's overloads and `ParentNode.querySelector` declares five.

A rejection counts as a counterexample, not just a synchronous throw: under
#12's one color, full surface, a clean entry promises both.

Sensitivity sits near 45%, so **a green gate is not evidence of cleanliness,
only the absence of a refutation.** `--self-check` plants known-throwing members
as clean and fails if the gate does not refute every one.

**The environment is jsdom**, not a browser: CI can run it with no browser
download, and it is a WebIDL-generated binding layer over the same algorithms,
which is the property the probe depends on. The cost is recorded rather than
hidden — jsdom reaches fewer interfaces than a browser, and **every clean claim
it cannot reach is unprobed, which ships floored**. Unprobed is not refuted, and
it is not evidence either.

**The deferred-invocation gate.** #30's Further Notes call this the spec's
terminal open item, so it gets a gate of its own. See below.

**The drift gate.** A symbol-set diff of `lib.dom*.d.ts`. `lib.dom.d.ts` has no
`lib.esXXXX` rhythm, but it does not need one: it is versioned by the TypeScript
release, which is the key the ES baseline already diffs against. Newcomers have
no entry and therefore floor, so the gate surfaces them rather than blocking.

Counterexamples the extractor cannot see are recorded in
[`src/refutations.ts`](src/refutations.ts) with their evidence, and those entries
ship throwing. A counterexample outside that list fails the build.

## Deferred invocation

A member that *queues* a callback rather than invoking it is the one place where
forgetting an entry is unsound rather than over-strict: the floor's only remedy
is `try { el.addEventListener('x', risky) } catch {}`, a bridge the engine
accepts while it neutralizes nothing.

A stack-recording callback answers the question directly — *was I invoked
synchronously?* — and that is exactly what a condition is about (#30 §B: which
parameters does this body transfer control into). Three outcomes, no fourth:

| verdict | evidence | entry |
| --- | --- | --- |
| `sync` | the callback ran before the call returned | conditional: `conditions: ["param<i>"]` |
| `queued` | it did not run during the call **and was seen running afterwards** | relaxation: `conditions: []` |
| `unreachable` | the probe could not call the member, or never saw the callback run at all | **no relaxation; the member floors** |

Both halves of `queued` are required, and the second is the load-bearing one:
a verdict read off "the callback did not run" is read off an *absence*, which is
the same unsafe direction as reading Gecko's silence as clean. `DOMTokenList`'s
`forEach` is the case that proves it — plainly synchronous, but a token list
with nothing in it never enters the callback, so absence would have called it
deferred. It is a self-check control for exactly that reason, and the gate also
rejects any `queued` entry whose evidence does not name what it saw happen.

No member currently ships a **non-empty** `conditions` list, and the `sync` row
of that table is a branch the pipeline can reach but the data does not: the only
DOM members that synchronously enter a callback parameter are the IDL-*generated*
`forEach`s, and those are floored for want of prose (see below). The probe
adjudicates them `sync` all the same, which is what makes the branch testable.

The price is paid where the callback is never invoked *for any* input:
`removeEventListener` and `createNodeIterator` take a callback they will not
enter, the probe cannot say so positively, and they floor. That is over-strict
and it is the direction the doctrine picks.

The adjudication is committed to
[`deferred-worklist.json`](deferred-worklist.json) so a reviewer can read every
member, its verdict and its evidence, and so CI can check the shipped data still
agrees. Nothing is left as "needs a human call".

## Known floors

Sound, and cheaper to state than to hide:

- **Members with no prose definition** — reflected ARIA attributes, specs that
  predate Bikeshed's `dfn` conventions (WebGL has 15 `<dfn>`s and zero
  `data-dfn-for` across ~1,150 members). #26 measured ~48.5%; this pass lands
  near 38% of the IDL-backed surface. Part of that number is a defect rather
  than a spec's silence: a definition Bikeshed promotes to a **section heading**
  carries its `data-dfn-*` on the `<h4>`, and the extractor reads `<dfn>` tags
  only, so every such member is invisible to it. The whole of `console.*` is —
  see [#130](https://github.com/no-throw/no-throw/issues/130).
- **Members the gate cannot reach**, which is jsdom's reach plus the members
  that would tear down the harness (`alert`, `close`, `submit`, …).
- **Members holding a callback they never enter** — see the price above.
- **IDL-generated iteration members** — `entries`, `keys`, `values`, `forEach`
  and `@@iterator` on an interface declaring `iterable<>`. WebIDL generates them
  and defines them in its own prose with no per-member attribution, so nothing
  in the pipeline reaches them. Coloring them would take a new adjudicated
  rule, not a new mechanism.
- **`setTimeout`, `queueMicrotask` and `requestAnimationFrame` are throwing**,
  which is worth stating plainly because #30 §E lists them among the
  deferred-invocation relaxations. Their *deferred* question is adjudicated —
  all three are `queued` — but they carry a throw of their own:
  `requestAnimationFrame` throws `NotSupportedError` where it is unsupported,
  and `setTimeout` reaches Trusted Types' string-compilation check because
  `TimerHandler` admits a `string`. The soundness doctrine settles it; the
  bridge those members need is a real one, not a fake one, because it catches
  the throw that is actually there. `addEventListener` — the case the
  fake-bridge hazard was named for — ships clean with `conditions: []`.

## Dials

The trust-base dials are shared with the ES baseline; see
[`docs/baseline-dials.md`](../../docs/baseline-dials.md). Sign-off is one-off
doctrine. Per release the cost is the symbol diff and the gates.

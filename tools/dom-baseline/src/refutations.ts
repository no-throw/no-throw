/**
 * Counterexamples the gate found and the extractor cannot see, recorded so the
 * entry ships **throwing** and the evidence lives in the repo rather than in
 * someone's memory.
 *
 * A counterexample outside this list fails the build — that is what makes the
 * gate a gate. This list is the narrow, auditable exception: each entry names
 * what was observed and why the prose does not contain it, so "the generator is
 * wrong" stays the default reading of a red gate.
 *
 * Nothing here ever moves an entry toward *clean*. Only toward throwing.
 */
export interface Refutation {
  readonly key: string;
  readonly observed: string;
  readonly why: string;
}

export const REFUTATIONS: readonly Refutation[] = [
  {
    key: "XPathEvaluatorBase#createExpression",
    observed: `throws on document.createExpression("") and on "!", " " and "<x>" — every one a conformant DOMString`,
    why: "The DOM standard restates the XPath IDL and defines no algorithm for it: `createExpression` appears fifteen times in the spec and not once with method steps, because the behaviour lives in the legacy DOM Level 3 XPath specification, which is not a Bikeshed document and carries no `data-dfn-for` attribution. Extraction is structurally blind to it, exactly as ECMA-262 extraction was blind to ECMA-402. An invalid expression really does throw, so the entry ships throwing.",
  },
];

export const REFUTED_KEYS: ReadonlySet<string> = new Set(
  REFUTATIONS.map((refutation) => refutation.key),
);

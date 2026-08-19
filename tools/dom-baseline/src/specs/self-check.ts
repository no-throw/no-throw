import { buildDfnGraph, type Form } from "./dfns.js";
import { hazardsOf, memberDfnIndex } from "./hazards.js";
import type { CachedSpec } from "./source.js";

/**
 * The control on {@link Form} that the count cannot be. A count says how much
 * of each form the corpus holds; it cannot say the form is read *correctly*,
 * and #130 was a form read not at all — which the members answered by
 * flooring, the safe direction and therefore a silent one.
 *
 * So each form faces the same two members here, one whose prose throws and one
 * whose does not, and has to carry both through the member index and the
 * hazard closure. A form that stops being read fails this rather than going
 * quiet. The fixtures are hand-written, so it needs no corpus.
 */

const DFN_FORM = `
<h3 class="heading settled" id="fixture-interface"><span class="secno">1.1. </span>The Fixture interface</h3>
<p>The <dfn class="dfn-paneled idl-code" data-dfn-for="Fixture" data-dfn-type="method"
 data-lt="quiet()" id="dom-fixture-quiet">quiet()</dfn> method steps are to return true.</p>
<p>The <dfn class="dfn-paneled idl-code" data-dfn-for="Fixture" data-dfn-type="method"
 data-lt="raises()" id="dom-fixture-raises">raises()</dfn> method steps are to
 <a href="https://webidl.spec.whatwg.org/#dfn-throw">throw</a> a
 "<code>TypeError</code>".</p>
`;

const HEADING_FORM = `
<h4 class="dfn-paneled heading idl-code settled" data-dfn-for="Fixture" data-dfn-type="method"
 data-export data-level="1.1.1" data-lt="quiet()" id="quiet"><span class="secno">1.1.1. </span>quiet()</h4>
<ol><li><p>Return true.</p></li></ol>
<h4 class="dfn-paneled heading idl-code settled" data-dfn-for="Fixture" data-dfn-type="method"
 data-export data-level="1.1.2" data-lt="raises()" id="raises"><span class="secno">1.1.2. </span>raises()</h4>
<ol><li><p><a href="https://webidl.spec.whatwg.org/#dfn-throw">Throw</a> a
 "<code>TypeError</code>".</p></li></ol>
`;

/**
 * The nesting case, which is the one place the two forms interact: HTML renders
 * a bare `<dfn>` inside six definitional headings' own titles. The heading is
 * what carries the `id`, so it is the definition, and the algorithm below the
 * title has to be read under it.
 */
const NESTED_FORM = `
<h4 id="dom-fixture-serialize" data-dfn-type="abstract-op" data-lt="Serialize"><span class="secno">2.7.4</span>
 <dfn>Serialize</dfn> ( <var>value</var> )</h4>
<ol><li><p>If <var>value</var> is a Symbol, then
 <a href="https://webidl.spec.whatwg.org/#dfn-throw">throw</a> a
 "<code>DataCloneError</code>" DOMException.</p></li></ol>
`;

const FIXTURES: readonly (readonly [Form, CachedSpec])[] = [
  ["dfn", { key: "fixture-dfn", html: DFN_FORM }],
  ["heading", { key: "fixture-heading", html: HEADING_FORM }],
];

export interface FormCheck {
  readonly form: Form;
  /** How many member definitions the extractor read out of the fixture. */
  readonly memberDefinitions: number;
  /** `raises()`, whose throw has to survive the hazard closure. */
  readonly sawHazard: boolean;
  /** `quiet()` — read, and read as having no hazard. */
  readonly sawCleanMember: boolean;
  readonly passed: boolean;
}

export function checkMarkupForms(): readonly FormCheck[] {
  return FIXTURES.map(([form, spec]) => {
    const graph = graphOf(spec);
    const index = memberDfnIndex(graph);
    const hazardsFor = (name: string): number | undefined => {
      const key = index.get(`fixture.${name}`)?.key;
      return key === undefined ? undefined : hazardsOf(graph, key)?.hazards.length;
    };
    const counted =
      graph.stats.memberDefinitionsByForm.find(([which]) => which === form)?.[1] ?? 0;
    const check = {
      form,
      memberDefinitions: counted,
      sawHazard: (hazardsFor("raises") ?? 0) > 0,
      sawCleanMember: hazardsFor("quiet") === 0,
    };
    return {
      ...check,
      passed: check.memberDefinitions === 2 && check.sawHazard && check.sawCleanMember,
    };
  });
}

/** Whether a definitional heading keeps the algorithm written below its title. */
export function checkNestedAnchor(): { readonly hazards: number; readonly passed: boolean } {
  const graph = graphOf({ key: "fixture-nested", html: NESTED_FORM });
  const hazards = hazardsOf(graph, "fixture-nested#dom-fixture-serialize")?.hazards.length ?? 0;
  return { hazards, passed: hazards > 0 };
}

function graphOf(spec: CachedSpec) {
  return buildDfnGraph({ specs: [spec], index: [{ key: spec.key, urls: [] }] });
}

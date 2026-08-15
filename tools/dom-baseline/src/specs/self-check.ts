import { buildDfnGraph, type MarkupForm } from "./dfns.js";
import { hazardsOf, memberDfnIndex } from "./hazards.js";
import type { CachedSpec } from "./source.js";

/**
 * The control on the extractor itself. #130 was a markup form the pipeline
 * never read: `console.*` is defined on section headings, so it was invisible
 * from extraction all the way down to the entry, and nothing anywhere said so —
 * the members simply floored, which is the safe direction and therefore silent.
 *
 * The by-form count the generator prints says *how much* of each form the
 * corpus holds. It cannot say the reading is right, so each form also faces the
 * same two members here: one whose prose throws and one whose prose does not.
 * A form that stops being read fails this rather than going quiet.
 *
 * The fixtures are hand-written, so this needs no corpus and runs anywhere.
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

const FIXTURES: readonly (readonly [MarkupForm, CachedSpec])[] = [
  ["dfn", { key: "fixture-dfn", html: DFN_FORM }],
  ["heading", { key: "fixture-heading", html: HEADING_FORM }],
];

export interface FormCheck {
  readonly form: MarkupForm;
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
    const graph = buildDfnGraph({ specs: [spec], index: [{ key: spec.key, urls: [] }] });
    const index = memberDfnIndex(graph);
    const hazardsFor = (name: string): number | undefined => {
      const key = index.get(`fixture.${name}`)?.key;
      return key === undefined ? undefined : hazardsOf(graph, key)?.hazards.length;
    };
    const check = {
      form,
      memberDefinitions: graph.stats.memberDefinitionsByForm[form],
      sawHazard: (hazardsFor("raises") ?? 0) > 0,
      sawCleanMember: hazardsFor("quiet") === 0,
    };
    return {
      ...check,
      passed: check.memberDefinitions === 2 && check.sawHazard && check.sawCleanMember,
    };
  });
}

// PROTOTYPE — throwaway (#26). Emits the data the in-page probe (probe.js) reads.
// The probe itself is a separate file on purpose: generating JS inside a template literal
// silently ate every regex backslash, which turned `/\|/` into `/|/` and made the fuzzer
// refuse every argument it should have synthesised.
import fs from 'node:fs';

const rows = JSON.parse(fs.readFileSync('out/member-hazards.json', 'utf8'));
const withProse = rows.filter((r) => r.prose);

// hand-signed: every one of these throws for a type-conformant argument. Sensitivity is
// measured against them — #22's rule that silence proves nothing, only counterexamples count.
const CONTROL_THROWS = [
  'Document.createElement',
  'Element.setAttribute',
  'Node.appendChild',
  'Node.removeChild',
  'Element.matches',
  'Element.closest',
  'Document.querySelector',
  'Element.querySelector',
  'Element.insertAdjacentHTML',
  'Element.setAttributeNS',
  'Document.createAttribute',
  'Range.setStart',
  'DOMTokenList.add',
  'Node.insertBefore',
  'Document.createElementNS',
];

const TAGS =
  'a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p param picture pre progress q rp rt ruby s samp script search section select slot small source span strong style sub summary sup table tbody td template textarea tfoot th thead time title tr track u ul var video wbr'.split(
    ' ',
  );

const targets = withProse.map((r) => ({
  owner: r.owner.replace(/\[\[ctor\]\]$/, ''),
  name: r.name,
  kind: r.kind,
  params: (r.params ?? []).map((p) => ({ type: p.type, optional: p.optional })),
  proposed: r.prose.hazards.length ? 'throwing' : 'clean',
}));

const json = (id, v) => `<script id=${id} type=application/json>${JSON.stringify(v)}</script>`;

fs.writeFileSync(
  'out/fuzz.html',
  [
    '<!doctype html><meta charset=utf-8><title>no-throw DOM probe</title>',
    '<body><pre id=out>running…</pre>',
    '<iframe id=sandbox style="width:300px;height:200px" srcdoc="&lt;body&gt;&lt;div id=probe&gt;&lt;p&gt;x&lt;/p&gt;&lt;/div&gt;"></iframe>',
    json('data', targets),
    json('tags', TAGS),
    json('controls', CONTROL_THROWS),
    '<script type=module src="/probe.js"></script>',
  ].join('\n'),
);

const clean = withProse.filter((r) => !r.prose.hazards.length).length;
console.log(`probe page written: out/fuzz.html (${targets.length} targets, ${clean} proposed clean)`);

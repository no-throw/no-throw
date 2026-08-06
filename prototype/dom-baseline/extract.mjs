// PROTOTYPE — throwaway (#26). The Bikeshed analogue of #22's ecmarkup extractor.
//
// ECMA-262 gives you `?`/`!` abrupt markers and `aoid=` cross-refs. Bikeshed gives
// you <dfn> anchors and hyperlinks. This builds the same object out of the latter:
// a graph of definitions, each with its own throw sites and its outbound calls,
// so a member's *whole hazard set* (#25) is a transitive closure over it.
import fs from 'node:fs';
import path from 'node:path';


const CACHE = 'cache';
const files = fs.readdirSync(CACHE).filter((f) => f.endsWith('.html'));

// --- id space --------------------------------------------------------------
// A link may be same-spec (`#foo`) or cross-spec (`https://dom.spec.whatwg.org/#foo`).
// Both must land on the same node, so index every spec's nightly origins. Keys are the
// *webref* shortnames, which is what the cache files are named after.
const specIndex = JSON.parse(fs.readFileSync('out/spec-index.json', 'utf8'));
const originToSpec = new Map();
for (const s of specIndex) for (const u of s.urls) originToSpec.set(u.replace(/#.*$/, ''), s.key);

const DFN_RE = /<dfn\b([^>]*)>/g;
const ATTR = (tag, name) => {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`)) ?? tag.match(new RegExp(`${name}='([^']*)'`));
  return m ? m[1] : undefined;
};
const stripTags = (s) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

// Bikeshed/WHATWG mark the act of throwing with a link to WebIDL's "throw" concept,
// or (older specs) with bare prose. Both are picked up; the link is the strong signal.
const THROW_RE = /(?:href="[^"]*#(?:dfn-throw|dfn-reject|dfn-perform-a-microtask-checkpoint)"[^>]*>\s*(throw|reject)|\b([Tt]hrow|throws|throwing|[Tt]hrown|[Rr]eject|rejects|rejected)\b)/g;
const EXC_RE = /"?<code[^>]*>(?:<a[^>]*>)?([A-Za-z]+(?:Error|Exception))/;
const NAMED_EXC_RE = /"([A-Za-z]+Error)"/;

// Concatenate the region's numbered-step content. Nested <ol>s make matched-tag parsing
// awkward, so a step runs from its <li> to the next <li>/</ol> — nested steps are simply
// steps in their own right, which is what we want.
const stepText = (region) => {
  const out = [];
  const marks = [...region.matchAll(/<li\b|<\/ol>/g)];
  for (let i = 0; i < marks.length; i++) {
    if (marks[i][0] === '</ol>') continue;
    const end = i + 1 < marks.length ? marks[i + 1].index : region.length;
    out.push(region.slice(marks[i].index, end));
  }
  return out.join('\n');
};

const nodes = new Map(); // key `spec#id` -> node
const byOrigin = new Map(); // absolute url without fragment -> spec shortname

let totalDfns = 0;
let totalThrowSites = 0;
const perSpec = [];

for (const file of files) {
  const shortname = path.basename(file, '.html');

  const html = fs.readFileSync(path.join(CACHE, file), 'utf8');

  // every <dfn> in document order; a definition's region runs to the next one
  const dfns = [];
  DFN_RE.lastIndex = 0;
  let m;
  while ((m = DFN_RE.exec(html))) dfns.push({ tag: m[1], start: m.index, bodyStart: m.index + m[0].length });

  let specThrows = 0;
  for (let i = 0; i < dfns.length; i++) {
    const d = dfns[i];
    const end = i + 1 < dfns.length ? dfns[i + 1].start : Math.min(html.length, d.start + 40000);
    const region = html.slice(d.bodyStart, end);
    const id = ATTR(d.tag, 'id');
    if (!id) continue;
    const key = `${shortname}#${id}`;
    const dfnFor = (ATTR(d.tag, 'data-dfn-for') ?? '').split(/[\s,]+/).filter(Boolean);
    const dfnType = ATTR(d.tag, 'data-dfn-type');
    const lt = (ATTR(d.tag, 'data-lt') ?? '').split('|').filter(Boolean);
    const label = stripTags(region.slice(0, 200)).slice(0, 80);

    // A hyperlink in a paragraph is a cross-reference; a hyperlink in a numbered step is
    // a call. ECMA-262 marks calls with `?`/`!`; Bikeshed marks them by being a step.
    // So *everything* below is read out of step lists only.
    const isMember = ['method', 'attribute', 'constructor'].includes(dfnType);
    // Not every algorithm is a numbered list: "The appendChild(node) method steps are to
    // return the result of appending node to this." is one sentence that delegates, and
    // reading only <ol>s reports it clean — a false-clean, which doctrine forbids.
    const proseAlgorithm = /\b(steps are|steps,? given|steps for|must return|must run|getter steps|setter steps|is to return|are to return|run these steps|following steps)\b/i.test(
      stripTags(region.slice(0, 2000)),
    );
    const steps = stepText(region);
    const isAlgorithm = steps.length > 0 || proseAlgorithm;
    // A member's whole region is about that member, so it may be read in full. A *noun*
    // definition's region is prose that merely sits next to other things — read its steps
    // only, or every concept in the spec inherits its neighbours' hazards.
    const scanned = isMember || proseAlgorithm ? region : steps;
    // Calls are read more widely than throws. Bikeshed definitions lead with the defining
    // sentence — "To append a node to a parent, pre-insert node into parent before null" —
    // which is the whole algorithm and delegates by hyperlink. Everything after it is
    // commentary and examples, and reading *that* is what made the graph dense.
    const calleeScan = isMember ? region : `${region.slice(0, 1200)}\n${steps}`;

    // --- own throw sites ---
    const own = [];
    THROW_RE.lastIndex = 0;
    let t;
    while ((t = THROW_RE.exec(scanned))) {
      const linked = !!t[1];
      const word = (t[1] ?? t[2]).toLowerCase();
      const kind = word.startsWith('rej') ? 'reject' : 'throw';
      // ignore mere cross-references to the concept ("see throw")
      const after = scanned.slice(t.index, t.index + 300);
      const before = scanned.slice(Math.max(0, t.index - 400), t.index);
      // Active voice puts the exception after the verb ("throw a "NotFoundError" DOMException");
      // passive voice puts it before ("An IndexSizeError exception MUST be thrown if …"), which
      // is the house style of the WebIDL-era specs. Look both ways.
      const exc =
        after.match(EXC_RE)?.[1] ??
        after.match(NAMED_EXC_RE)?.[1] ??
        (/TypeError/.test(after) ? 'TypeError' : undefined) ??
        stripTags(before).match(/\b([A-Z][A-Za-z]*(?:Error|Exception))\b(?![\s\S]*\b[A-Z][A-Za-z]*(?:Error|Exception)\b)/)?.[1];
      if (!linked && !exc) continue; // bare word with no exception named — too weak
      const ctx = stripTags(before);
      const cond = ctx.match(/(If|Otherwise, if|Unless|When|For each)\b[^.]{0,220}$/)?.[0] ?? ctx.slice(-160);
      own.push({ kind, exc: exc ?? 'unknown', cond, linked });
      if (own.length >= 40) break;
    }
    specThrows += own.length;

    // --- outbound calls: links into other definitions ---
    const callees = new Set();
    for (const a of calleeScan.matchAll(/<a\b[^>]*href="([^"]+)"/g)) {
      const href = a[1];
      if (href.startsWith('#')) callees.add(`${shortname}${href}`);
      else if (/^https?:/.test(href) && href.includes('#')) {
        const [base, frag] = href.split('#');
        const target = originToSpec.get(base) ?? originToSpec.get(base.replace(/\/multipage\/[^/]*$/, '/'));
        if (target) callees.add(`${target}#${frag}`);
      }
      if (callees.size >= 200) break;
    }

    nodes.set(key, { key, spec: shortname, id, dfnFor, dfnType, lt, label, isAlgorithm, own, callees: [...callees] });
    totalDfns++;
  }
  totalThrowSites += specThrows;
  perSpec.push({ shortname, dfns: dfns.length, throwSites: specThrows, mb: +(html.length / 1e6).toFixed(2) });
}

fs.mkdirSync('out', { recursive: true });
fs.writeFileSync('out/dfn-graph.json', JSON.stringify([...nodes.values()]));

const memberDfns = [...nodes.values()].filter((n) => ['method', 'attribute', 'constructor'].includes(n.dfnType) && n.dfnFor.length);
const withOwnThrows = [...nodes.values()].filter((n) => n.own.length);
const danglingCallees = (() => {
  let dangling = 0;
  let total = 0;
  for (const n of nodes.values())
    for (const c of n.callees) {
      total++;
      if (!nodes.has(c)) dangling++;
    }
  return { total, dangling };
})();

console.log(`specs parsed:        ${files.length}`);
console.log(`definitions indexed: ${totalDfns}`);
console.log(`  member dfns:       ${memberDfns.length}`);
console.log(`definitions with own throw sites: ${withOwnThrows.length}  (${totalThrowSites} sites)`);
console.log(
  `callee links: ${danglingCallees.total}  resolved: ${danglingCallees.total - danglingCallees.dangling} (${(
    (1 - danglingCallees.dangling / danglingCallees.total) * 100
  ).toFixed(1)}%)`,
);
console.log(
  '\ntop specs by throw sites:',
  perSpec
    .sort((a, b) => b.throwSites - a.throwSites)
    .slice(0, 12)
    .map((s) => `${s.shortname}:${s.throwSites}`)
    .join(' '),
);

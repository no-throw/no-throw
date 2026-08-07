import { loadCachedSpecs, loadSpecIndex } from "./source.js";

/**
 * The Bikeshed analogue of the ecmarkup extractor. ECMA-262 hands you `?`/`!`
 * abrupt markers and `aoid=` cross-references; Bikeshed hands you `<dfn>`
 * anchors and hyperlinks, and **says nothing about which links are calls**. A
 * hyperlink is a call, a cross-reference, or a noun.
 *
 * Read naively the graph is useless — #26 measured a median of 131 definitions
 * visited per member and `Element.getAttribute` reported throwing. Three rules
 * take it to a median of 4, and each is a soundness/precision trade made here
 * rather than discovered late:
 *
 * 1. **Members are leaves.** Prose links `document.domain` to *point at* it,
 *    not to call it. Leaving members in the propagating set made
 *    `document.domain` the root cause of 1,676 hazards.
 * 2. **Throws count from a member's own region, or from a noun's steps only.**
 *    Otherwise every concept inherits its neighbours' hazards.
 * 3. **Calls count from the definitional sentence plus the steps.** Not every
 *    algorithm is a numbered list: *"To append a node to a parent, pre-insert
 *    node into parent before null"* is one sentence that delegates, and reading
 *    only `<ol>`s reported `Node.appendChild` clean — a false clean.
 */

export interface ProseThrow {
  readonly kind: "throw" | "reject";
  readonly exception: string;
  /** The prose leading up to the throw — what the classifier keys on. */
  readonly condition: string;
  /** Hyperlinked to WebIDL's `throw` concept, rather than matched as prose. */
  readonly linked: boolean;
  /**
   * Which half of an attribute the throw belongs to. #29 §1 makes get and set
   * independent colours normative — reading `location.href` must not require
   * the bridge that assigning to it does — and an attribute's definition writes
   * both algorithms in one region, so the split is read off the position of the
   * "setter steps" heading. Everything else is `both`.
   */
  readonly phase: "get" | "set" | "both";
}

export interface Dfn {
  /** `dom#dom-element-matches` — spec shortname plus anchor. */
  readonly key: string;
  readonly spec: string;
  readonly id: string;
  readonly dfnFor: readonly string[];
  readonly dfnType: string | undefined;
  readonly lt: readonly string[];
  readonly label: string;
  readonly isAlgorithm: boolean;
  readonly throws: readonly ProseThrow[];
  readonly callees: readonly Callee[];
}

export interface Callee {
  readonly key: string;
  /** Which half of an attribute delegates here; `both` for everything else. */
  readonly phase: "get" | "set" | "both";
}

export interface DfnGraph {
  readonly nodes: ReadonlyMap<string, Dfn>;
  readonly stats: {
    readonly specs: number;
    readonly definitions: number;
    readonly memberDefinitions: number;
    readonly throwSites: number;
    readonly aliasRuns: number;
    readonly calleeLinks: number;
    readonly resolvedCalleeLinks: number;
  };
}

const MEMBER_DFN_TYPES = new Set(["method", "attribute", "constructor"]);

const DFN_TAG = /<dfn\b([^>]*)>/g;
const LINK = /<a\b[^>]*href="([^"]+)"/g;

/**
 * WHATWG and Bikeshed mark the act of throwing with a link to WebIDL's `throw`
 * concept; older WebIDL-era specs write bare prose, often in the passive
 * (*"An `IndexSizeError` exception MUST be thrown if …"* — 117 of them in Web
 * Audio alone). #26 found the passive-voice blind spot only through the fuzz
 * gate, so both voices are matched.
 */
const THROW_SITE =
  /(?:href="[^"]*#(?:dfn-throw|dfn-reject)"[^>]*>\s*(throw|reject)|\b([Tt]hrows?|[Tt]hrowing|[Tt]hrown|[Rr]ejects?|[Rr]ejecting|[Rr]ejected)\b)/g;
const EXCEPTION_AFTER = /"?<code[^>]*>(?:<a[^>]*>)?([A-Za-z]+(?:Error|Exception))/;
const NAMED_EXCEPTION_AFTER = /"([A-Za-z]+Error)"/;
/** Passive voice puts the exception *before* the verb, so look backwards too. */
const EXCEPTION_BEFORE =
  /\b([A-Z][A-Za-z]*(?:Error|Exception))\b(?![\s\S]*\b[A-Z][A-Za-z]*(?:Error|Exception)\b)/;

const PROSE_ALGORITHM =
  /\b(steps are|steps,? given|steps for|must return|must run|getter steps|setter steps|is to return|are to return|run these steps|following steps)\b/i;

/** A region past this is a section, not a definition; the cap bounds the work. */
const MAX_REGION = 40_000;
/**
 * Below this much text between two `<dfn>`s, the first is an alias stub rather
 * than a definition of its own. `Element`'s `matches` and
 * `webkitMatchesSelector` share one algorithm, and the second `<dfn>` ends the
 * first's region before the algorithm starts — #25's spec-aliasing finding
 * recurring in a different markup language, and again found only by the hostile
 * fuzzer. Merging the run is the over-approximating direction: an alias
 * inherits hazards it might not have, never the reverse.
 */
const ALIAS_STUB = 60;

const MAX_THROWS_PER_DFN = 40;
const MAX_CALLEES_PER_DFN = 200;

interface RawDfn {
  readonly tag: string;
  readonly start: number;
  readonly bodyStart: number;
}

export function buildDfnGraph(): DfnGraph {
  const originToSpec = new Map<string, string>();
  for (const target of loadSpecIndex()) {
    for (const url of target.urls) {
      originToSpec.set(url.replace(/#.*$/, ""), target.key);
    }
  }

  const nodes = new Map<string, Dfn>();
  let specs = 0;
  let throwSites = 0;
  let aliasRuns = 0;

  for (const { key: shortname, html } of loadCachedSpecs()) {
    specs++;
    const raw: RawDfn[] = [];
    DFN_TAG.lastIndex = 0;
    for (let match = DFN_TAG.exec(html); match !== null; match = DFN_TAG.exec(html)) {
      raw.push({
        tag: match[1] ?? "",
        start: match.index,
        bodyStart: match.index + match[0].length,
      });
    }

    for (const [index, dfn] of raw.entries()) {
      const id = attribute(dfn.tag, "id");
      if (id === undefined) continue;
      const { region, runLength } = regionOf(html, raw, index);
      if (runLength > 1) aliasRuns++;
      const node = readDfn(shortname, id, dfn.tag, region, originToSpec);
      throwSites += node.throws.length;
      if (!nodes.has(node.key)) nodes.set(node.key, node);
    }
  }

  let calleeLinks = 0;
  let resolvedCalleeLinks = 0;
  let memberDefinitions = 0;
  for (const node of nodes.values()) {
    if (MEMBER_DFN_TYPES.has(node.dfnType ?? "") && node.dfnFor.length > 0) {
      memberDefinitions++;
    }
    for (const callee of node.callees) {
      calleeLinks++;
      if (nodes.has(callee.key)) resolvedCalleeLinks++;
    }
  }

  return {
    nodes,
    stats: {
      specs,
      definitions: nodes.size,
      memberDefinitions,
      throwSites,
      aliasRuns,
      calleeLinks,
      resolvedCalleeLinks,
    },
  };
}

/**
 * A definition's region runs to the next `<dfn>` — except across a run of
 * alias stubs, which share the region that follows the last of them.
 */
function regionOf(
  html: string,
  raw: readonly RawDfn[],
  index: number,
): { region: string; runLength: number } {
  let last = index;
  while (last + 1 < raw.length) {
    const next = raw[last + 1];
    const current = raw[last];
    if (next === undefined || current === undefined) break;
    if (!aliases(current.tag, next.tag)) break;
    // Only an immediate neighbour is an alias: `matches(selectors)</dfn> and
    // <dfn>webkitMatchesSelector(selectors)`. Anything with a step list, a
    // paragraph break or more than a clause of prose between them is a
    // definition of its own, and merging those made the graph denser than the
    // naive reading it was meant to fix.
    const between = html.slice(current.bodyStart, next.start);
    if (/<li\b|<\/ol>|<\/p>|<h\d/.test(between)) break;
    if (stripTags(between).length >= ALIAS_STUB) break;
    last++;
  }
  const from = raw[last];
  if (from === undefined) return { region: "", runLength: 1 };
  const after = raw[last + 1];
  const end = after === undefined ? Math.min(html.length, from.start + MAX_REGION) : after.start;
  return { region: html.slice(from.bodyStart, end), runLength: last - index + 1 };
}

/**
 * Two definitions are aliases only if they define the *same kind of thing for
 * the same interface*. Without that, a run merges unrelated neighbours and the
 * graph comes out denser than the naive reading the merge exists to fix.
 */
function aliases(left: string, right: string): boolean {
  const type = attribute(left, "data-dfn-type");
  return (
    type !== undefined &&
    MEMBER_DFN_TYPES.has(type) &&
    type === attribute(right, "data-dfn-type") &&
    attribute(left, "data-dfn-for") === attribute(right, "data-dfn-for")
  );
}

function readDfn(
  shortname: string,
  id: string,
  tag: string,
  region: string,
  originToSpec: ReadonlyMap<string, string>,
): Dfn {
  const dfnType = attribute(tag, "data-dfn-type");
  const dfnFor = (attribute(tag, "data-dfn-for") ?? "").split(/[\s,]+/).filter(Boolean);
  const lt = (attribute(tag, "data-lt") ?? "").split("|").filter(Boolean);
  const isMember = MEMBER_DFN_TYPES.has(dfnType ?? "");
  const steps = stepText(region);
  const proseAlgorithm = PROSE_ALGORITHM.test(stripTags(region.slice(0, 2000)));

  // Rule 2 — a member's whole region is about that member, so it may be read in
  // full; a *noun* definition's region is prose that merely sits next to other
  // things, so only its steps count.
  const throwScan = isMember || proseAlgorithm ? region : steps;
  // Rule 3 — calls are read more widely than throws, because the defining
  // sentence *is* the algorithm in a great many definitions. Everything past it
  // is commentary and examples, and reading that is what made the graph dense.
  const calleeScan = isMember ? region : `${region.slice(0, 1200)}\n${steps}`;
  const setterAt = dfnType === "attribute" ? setterFrom(throwScan) : undefined;
  const calleeSetterAt = dfnType === "attribute" ? setterFrom(calleeScan) : undefined;

  return {
    key: `${shortname}#${id}`,
    spec: shortname,
    id,
    dfnFor,
    dfnType,
    lt,
    label: stripTags(region.slice(0, 200)).slice(0, 80),
    isAlgorithm: steps.length > 0 || proseAlgorithm,
    throws: readThrows(throwScan, setterAt),
    callees: readCallees(calleeScan, shortname, originToSpec, calleeSetterAt),
  };
}

const SETTER_HEADING = /\bsetter steps\b|\bon setting\b|\bsetting\s+(?:the\s+)?(?:it|this)\b/i;

/**
 * Where an attribute's setter algorithm begins. Before it the prose is the
 * getter's, after it the setter's. Absent the heading the whole region is
 * `both`, which is the over-approximating direction.
 */
function setterFrom(region: string): number | undefined {
  const at = SETTER_HEADING.exec(region)?.index;
  return at;
}

function readThrows(
  scanned: string,
  setterAt: number | undefined,
): readonly ProseThrow[] {
  const found: ProseThrow[] = [];
  THROW_SITE.lastIndex = 0;
  for (
    let match = THROW_SITE.exec(scanned);
    match !== null && found.length < MAX_THROWS_PER_DFN;
    match = THROW_SITE.exec(scanned)
  ) {
    const linked = match[1] !== undefined;
    const word = (match[1] ?? match[2] ?? "").toLowerCase();
    const after = scanned.slice(match.index, match.index + 300);
    const before = scanned.slice(Math.max(0, match.index - 400), match.index);
    const exception =
      EXCEPTION_AFTER.exec(after)?.[1] ??
      NAMED_EXCEPTION_AFTER.exec(after)?.[1] ??
      (/TypeError/.test(after) ? "TypeError" : undefined) ??
      EXCEPTION_BEFORE.exec(stripTags(before))?.[1];
    // A bare "throws" with no exception named anywhere is a cross-reference to
    // the concept, not a throw site.
    if (!linked && exception === undefined) continue;
    const context = stripTags(before);
    found.push({
      kind: word.startsWith("rej") ? "reject" : "throw",
      exception: exception ?? "unknown",
      condition:
        /(If|Otherwise, if|Unless|When|For each)\b[^.]{0,220}$/.exec(context)?.[0] ??
        context.slice(-160),
      linked,
      phase: setterAt === undefined ? "both" : match.index >= setterAt ? "set" : "get",
    });
  }
  return found;
}

function readCallees(
  scanned: string,
  shortname: string,
  originToSpec: ReadonlyMap<string, string>,
  setterAt: number | undefined,
): readonly Callee[] {
  const callees = new Map<string, Callee>();
  LINK.lastIndex = 0;
  for (
    let match = LINK.exec(scanned);
    match !== null && callees.size < MAX_CALLEES_PER_DFN;
    match = LINK.exec(scanned)
  ) {
    const href = match[1] ?? "";
    const phase =
      setterAt === undefined ? "both" : match.index >= setterAt ? "set" : "get";
    let key: string | undefined;
    if (href.startsWith("#")) {
      key = `${shortname}${href}`;
    } else if (/^https?:/.test(href) && href.includes("#")) {
      const [base, fragment] = href.split("#");
      const target =
        base === undefined
          ? undefined
          : (originToSpec.get(base) ??
            originToSpec.get(base.replace(/\/multipage\/[^/]*$/, "/")));
      if (target !== undefined && fragment !== undefined) key = `${target}#${fragment}`;
    }
    if (key === undefined) continue;
    const existing = callees.get(key);
    callees.set(key, {
      key,
      // Linked from both halves means it belongs to both.
      phase: existing === undefined || existing.phase === phase ? phase : "both",
    });
  }
  return [...callees.values()];
}

/**
 * The region's numbered-step content. Nested `<ol>`s make matched-tag parsing
 * awkward, so a step runs from its `<li>` to the next `<li>` or `</ol>` —
 * nested steps become steps in their own right, which is what we want.
 */
function stepText(region: string): string {
  const marks = [...region.matchAll(/<li\b|<\/ol>/g)];
  const out: string[] = [];
  for (const [index, mark] of marks.entries()) {
    if (mark[0] === "</ol>" || mark.index === undefined) continue;
    const end = marks[index + 1]?.index ?? region.length;
    out.push(region.slice(mark.index, end));
  }
  return out.join("\n");
}

function attribute(tag: string, name: string): string | undefined {
  return (
    new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ??
    new RegExp(`${name}='([^']*)'`).exec(tag)?.[1]
  );
}

export function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

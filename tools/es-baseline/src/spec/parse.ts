/**
 * Ecmarkup is the worklist engine. ECMA-262's `spec.html` marks up every
 * clause, every algorithm step, every abstract-operation cross-reference
 * (`aoid=`) and, through §5.2.4.3's `?`/`!`, whether a call may complete
 * abruptly. That is enough to resolve abstract-op indirection transitively,
 * which is what turns thousands of throw sites into a few dozen root causes.
 */

export interface Clause {
  readonly id: string;
  readonly type: string | undefined;
  readonly aoid: string | undefined;
  title: string;
  /** Clause content with nested clauses removed, so a parent's steps are its own. */
  ownHtml: string;
  readonly start: number;
  readonly contentStart: number;
  end: number;
  readonly parent: Clause | undefined;
}

const CLAUSE_TAG = /<(\/?)emu-clause\b[^>]*>/g;
const CLAUSE_OPEN = /<emu-clause\s+id=([^\s>]+)([^>]*)>/g;

export function parseClauses(html: string): readonly Clause[] {
  const clauses: Clause[] = [];
  const stack: Clause[] = [];
  CLAUSE_TAG.lastIndex = 0;

  for (let tag = CLAUSE_TAG.exec(html); tag !== null; tag = CLAUSE_TAG.exec(html)) {
    if (tag[1] === "/") {
      const open = stack.pop();
      if (open !== undefined) {
        open.end = tag.index;
        open.ownHtml = html.slice(open.contentStart, open.end);
      }
      continue;
    }
    CLAUSE_OPEN.lastIndex = tag.index;
    const open = CLAUSE_OPEN.exec(html);
    const attrs = open !== null && open.index === tag.index ? (open[2] ?? "") : "";
    const rawId = open !== null && open.index === tag.index ? (open[1] ?? "?") : "?";
    const clause: Clause = {
      id: rawId.replace(/"/g, ""),
      type: /type="([^"]*)"/.exec(attrs)?.[1],
      aoid: /\baoid=("?)([\w$]+)\1/.exec(attrs)?.[2],
      title: "",
      ownHtml: "",
      start: tag.index,
      contentStart: tag.index + tag[0].length,
      end: tag.index,
      parent: stack[stack.length - 1],
    };
    clauses.push(clause);
    stack.push(clause);
  }

  const children = new Map<Clause, Clause[]>();
  for (const clause of clauses) {
    if (clause.parent === undefined) continue;
    const siblings = children.get(clause.parent) ?? [];
    siblings.push(clause);
    children.set(clause.parent, siblings);
  }

  for (const clause of clauses) {
    const full = html.slice(clause.contentStart, clause.end);
    clause.title = stripTags(/<h1>([\s\S]*?)<\/h1>/.exec(full)?.[1] ?? "").replace(
      /^[\d.]+\s*/,
      "",
    );
    const kids = (children.get(clause) ?? []).sort((a, b) => a.start - b.start);
    if (kids.length === 0) {
      clause.ownHtml = full;
      continue;
    }
    let own = "";
    let cursor = clause.contentStart;
    for (const kid of kids) {
      own += html.slice(cursor, kid.start);
      cursor = kid.end + "</emu-clause>".length;
    }
    clause.ownHtml = own + html.slice(cursor, clause.end);
  }

  return clauses;
}

export function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface Step {
  /** The step's own markup, with sub-steps removed. */
  readonly html: string;
  readonly text: string;
  /**
   * The step's text prefixed by its ancestors'. A bare "Throw a TypeError
   * exception." carries no condition — the condition is the enclosing step —
   * so without the chain such a site is unclassifiable prose.
   */
  readonly context: string;
  readonly index: number;
}

interface RawStep {
  readonly contentStart: number;
  readonly parent: RawStep | undefined;
  raw: string;
  text: string;
}

const LIST_ITEM = /<(\/?)li\b[^>]*>/g;

export function algorithmSteps(ownHtml: string): readonly Step[] {
  const raws: RawStep[] = [];
  for (const alg of ownHtml.matchAll(/<emu-alg>([\s\S]*?)<\/emu-alg>/g)) {
    const body = alg[1] ?? "";
    const stack: RawStep[] = [];
    LIST_ITEM.lastIndex = 0;
    for (let tag = LIST_ITEM.exec(body); tag !== null; tag = LIST_ITEM.exec(body)) {
      if (tag[1] === "/") {
        const open = stack.pop();
        if (open !== undefined) open.raw = body.slice(open.contentStart, tag.index);
        continue;
      }
      const item: RawStep = {
        contentStart: tag.index + tag[0].length,
        parent: stack[stack.length - 1],
        raw: "",
        text: "",
      };
      raws.push(item);
      stack.push(item);
    }
  }

  const steps: Step[] = [];
  for (const raw of raws) {
    // A step's own text excludes its sub-steps: a throw belongs to the step
    // that performs it, not to every step above it.
    const html = raw.raw.replace(/<ol[\s\S]*$/, "");
    raw.text = stripTags(html);
    if (raw.text === "") continue;
    const ancestry: string[] = [];
    for (let up = raw.parent; up !== undefined; up = up.parent) {
      if (up.text !== "") ancestry.unshift(up.text);
    }
    steps.push({
      html,
      text: raw.text,
      context: ancestry.length === 0 ? raw.text : `${ancestry.join(" ")} ${raw.text}`,
      index: steps.length,
    });
  }
  return steps;
}

export const THROW_SITE =
  /throw an? <emu-val>(TypeError|RangeError|SyntaxError|ReferenceError|URIError|EvalError)<\/emu-val>/i;

export interface CallSite {
  readonly kind: "abstract-op" | "internal-method";
  /** `?` propagates abruptness; `!` asserts it never happens (§5.2.4.3). */
  readonly mark: "?" | "!";
  readonly name: string;
}

const AO_CALL = /([?!])\s*<emu-xref[^>]*\baoid=("?)([\w$𝔽ℝ]+)\2[^>]*>/g;
const INTERNAL_CALL = /([?!])\s*(?:<[^>]+>|\w|\.|\s)*?\[\[(\w+)\]\]/g;

export function callSites(stepHtml: string): readonly CallSite[] {
  const sites: CallSite[] = [];
  for (const match of stepHtml.matchAll(AO_CALL)) {
    sites.push({
      kind: "abstract-op",
      mark: match[1] === "!" ? "!" : "?",
      name: match[3] ?? "",
    });
  }
  for (const match of stepHtml.matchAll(INTERNAL_CALL)) {
    sites.push({
      kind: "internal-method",
      mark: match[1] === "!" ? "!" : "?",
      name: `[[${match[2] ?? ""}]]`,
    });
  }
  return sites.filter((site) => site.name !== "");
}

/** The parenthesized argument list of `Op(...)` in a step's plain text. */
export function argumentsOf(text: string, op: string): string | undefined {
  const at = text.indexOf(`${op}(`);
  if (at < 0) return undefined;
  let depth = 0;
  for (let index = at + op.length; index < text.length; index++) {
    const char = text[index];
    if (char === "(") depth++;
    else if (char === ")") {
      depth--;
      if (depth === 0) return text.slice(at + op.length + 1, index);
    }
  }
  return undefined;
}

/** Split an argument list at top-level commas, respecting `(`, `«` and `[`. */
export function splitArguments(text: string | undefined): readonly string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text ?? "") {
    if ("(«[".includes(char)) depth++;
    else if (")»]".includes(char)) depth--;
    if (char === "," && depth === 0) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim() !== "") out.push(current.trim());
  return out.filter((argument) => argument !== "");
}

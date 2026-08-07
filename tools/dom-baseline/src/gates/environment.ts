import { JSDOM, VirtualConsole } from "jsdom";

/**
 * The gate needs a DOM, and #26 established that it needs a *real* one: benign
 * type-conformant arguments refuted 0 of 7 hand-signed controls, where the
 * hostile pool refuted 7 of 7. What it does not need is a browser download in
 * CI, so this is jsdom — a WebIDL-generated binding layer over the same
 * algorithms, which is exactly the property the probe depends on.
 *
 * The consequence is recorded rather than hidden: jsdom reaches fewer
 * interfaces than a browser, and every clean claim it cannot reach is
 * **unprobed**, which ships floored. Unprobed is not refuted, and it is not
 * evidence either.
 */

const MARKUP = `<!doctype html><html><head><title>probe</title></head><body>
<div id="probe"><p id="para">text</p><span>x</span></div>
<form id="form"><input id="input" name="i" value="v"><select id="select"><option>o</option></select><textarea id="area"></textarea></form>
<table id="table"><tbody><tr><td>c</td></tr></tbody></table>
</body></html>`;

const HTML_TAGS =
  "a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p param picture pre progress q rp rt ruby s samp script search section select slot small source span strong style sub summary sup table tbody td template textarea tfoot th thead time title tr track u ul var video wbr".split(
    " ",
  );

const SVG_TAGS = ["svg", "g", "rect", "circle", "path", "text", "defs", "use"];

/**
 * Constructing these navigates, opens a socket, or blocks on a dialog, and a
 * probe that tears down its own harness measures nothing.
 */
const UNSAFE_CONSTRUCTORS =
  /^(WebSocket|EventSource|Worker|SharedWorker|RTCPeerConnection|XMLHttpRequest|Notification|BroadcastChannel|SpeechSynthesisUtterance)$/;

export interface DomEnvironment {
  readonly window: Window & typeof globalThis;
  readonly document: Document;
  /** Constructor name → one live instance. */
  readonly pool: ReadonlyMap<string, unknown>;
  readonly close: () => void;
}

export function createDomEnvironment(): DomEnvironment {
  // jsdom reports an unimplemented member by writing to its virtual console,
  // not by throwing. That is exactly the "silence proves nothing" case, and
  // relaying thousands of them would bury the counterexamples that do count.
  const dom = new JSDOM(MARKUP, {
    url: "https://example.org/probe",
    pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  });
  const window = dom.window as unknown as Window & typeof globalThis;
  const document = window.document;
  const pool = new Map<string, unknown>();

  const remember = (value: unknown): void => {
    if (value === null || value === undefined) return;
    let prototype: object | null;
    try {
      prototype = Object.getPrototypeOf(value) as object | null;
    } catch {
      return;
    }
    // Every interface the value implements, not only its most derived one: a
    // `div` is the pool's `HTMLDivElement`, `HTMLElement`, `Element` and `Node`
    // all at once, which is what gives the mixins a receiver at all.
    while (prototype !== null && prototype !== Object.prototype) {
      const name = (prototype as { constructor?: { name?: string } }).constructor?.name;
      if (name !== undefined && name !== "" && !pool.has(name)) pool.set(name, value);
      prototype = Object.getPrototypeOf(prototype) as object | null;
    }
  };

  const globals = window as unknown as Record<string, unknown>;
  for (const value of [
    window,
    document,
    globals["navigator"],
    globals["location"],
    globals["history"],
    globals["performance"],
    globals["screen"],
    globals["localStorage"],
    globals["sessionStorage"],
    globals["customElements"],
    globals["crypto"],
    document.documentElement,
    document.head,
    document.body,
    document.implementation,
    document.doctype,
    document.createTextNode("x"),
    document.createComment("c"),
    document.createDocumentFragment(),
    document.createRange(),
    document.createAttribute("data-x"),
    document.body.classList,
    document.body.style,
    document.body.attributes,
    document.querySelectorAll("*"),
    document.body.childNodes,
    document.body.children,
    document.getElementById("probe"),
    document.getElementById("form"),
    document.getElementById("input"),
    document.createTreeWalker(document.body),
    document.createNodeIterator(document.body),
    document.createEvent("Event"),
  ]) {
    try {
      remember(value);
    } catch {
      /* an interface this engine does not implement is simply unprobed */
    }
  }

  for (const tag of HTML_TAGS) {
    try {
      remember(document.createElement(tag));
    } catch {
      /* likewise */
    }
  }
  for (const tag of SVG_TAGS) {
    try {
      remember(document.createElementNS("http://www.w3.org/2000/svg", tag));
    } catch {
      /* likewise */
    }
  }

  // A zero-argument construction that succeeds is conformant by definition.
  for (const name of Object.getOwnPropertyNames(window)) {
    if (!/^[A-Z]/.test(name) || UNSAFE_CONSTRUCTORS.test(name) || pool.has(name)) {
      continue;
    }
    let constructor: unknown;
    try {
      constructor = globals[name];
    } catch {
      continue;
    }
    if (typeof constructor !== "function") continue;
    for (const args of [[], ["x"], ["x", {}], ["x", "y"]]) {
      if (pool.has(name)) break;
      try {
        remember(Reflect.construct(constructor, args));
      } catch {
        /* not constructible this way */
      }
    }
  }

  return { window, document, pool, close: () => dom.window.close() };
}

/**
 * A receiver for a member declared on `owner`, preferring the interface itself
 * and falling back to anything that implements it. `ARIAMixin` and
 * `GlobalEventHandlers` have no constructor of their own, so without the
 * fallback the whole mixin surface — a large part of `lib.dom.d.ts` — would be
 * unprobed.
 */
export function receiverFor(
  environment: DomEnvironment,
  owner: string,
  implementers: ReadonlyMap<string, readonly string[]>,
): unknown {
  const direct = environment.pool.get(owner);
  if (direct !== undefined) return direct;
  for (const candidate of implementers.get(owner) ?? []) {
    const instance = environment.pool.get(candidate);
    if (instance !== undefined) return instance;
  }
  return undefined;
}

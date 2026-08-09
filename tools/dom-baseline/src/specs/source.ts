import { createRequire } from "node:module";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The prose corpus: the nightly HTML of every spec `web-specs` knows about, not
 * only the ones that ship IDL. #26 measured that difference and recorded it as
 * a negative result — closing the corpus from 329 to 799 specs moved member
 * coverage 50.4% → 51.5% and left the counterexample count unchanged, so it
 * buys almost no precision. It is fetched anyway, because the alternative is a
 * blind spot you cannot see: `Element.matches`'s `SyntaxError` is defined in
 * Selectors, which has no IDL of its own.
 *
 * Cached rather than vendored, like the ECMA-262 spec: only generation needs
 * it, and every gate runs over the generated data.
 */

interface WebSpec {
  readonly shortname: string;
  readonly series?: { readonly shortname?: string };
  readonly standing?: string;
  readonly url?: string;
  readonly nightly?: { readonly url?: string; readonly alternateUrls?: readonly string[] };
  readonly release?: { readonly url?: string };
}

export interface SpecTarget {
  readonly key: string;
  readonly urls: readonly string[];
}

const CACHE_DIR = new URL("../../.cache/specs/", import.meta.url);
const INDEX_FILE = new URL("../../.cache/spec-index.json", import.meta.url);

export function specCacheDir(): string {
  return fileURLToPath(CACHE_DIR);
}

/**
 * WHATWG multipage URLs carry no algorithms on the index page; the single-page
 * build is where the prose actually is.
 */
function singlePage(url: string): string {
  return url.replace(/\/multipage\/?$/, "/");
}

export function specTargets(): readonly SpecTarget[] {
  const require = createRequire(import.meta.url);
  const specs = require("web-specs") as readonly WebSpec[];
  return specs
    .filter((spec) => spec.standing === undefined || spec.standing === "good")
    .map((spec) => ({
      key: spec.shortname,
      urls: [
        ...new Set(
          [
            spec.nightly?.url,
            spec.release?.url,
            ...(spec.nightly?.alternateUrls ?? []),
            spec.url,
          ]
            .filter((url): url is string => url !== undefined)
            .map(singlePage),
        ),
      ],
    }))
    .filter((target) => target.urls.length > 0)
    .sort((left, right) => left.key.localeCompare(right.key));
}

export interface FetchReport {
  readonly targets: number;
  readonly cached: number;
  readonly bytes: number;
  readonly failures: readonly (readonly [key: string, url: string, error: string])[];
}

const CONCURRENCY = 8;

export async function fetchSpecs(): Promise<FetchReport> {
  const targets = specTargets();
  const dir = specCacheDir();
  mkdirSync(dir, { recursive: true });

  let cached = 0;
  let bytes = 0;
  const failures: (readonly [string, string, string])[] = [];
  const queue = [...targets];

  const worker = async (): Promise<void> => {
    for (let target = queue.shift(); target !== undefined; target = queue.shift()) {
      const file = join(dir, `${target.key}.html`);
      try {
        bytes += statSync(file).size;
        cached++;
        continue;
      } catch {
        /* not cached yet */
      }
      const url = target.urls[0];
      if (url === undefined) continue;
      try {
        const response = await fetch(url, {
          headers: { "user-agent": "no-throw-dom-baseline/0.1" },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const html = await response.text();
        writeFileSync(file, html);
        bytes += html.length;
        cached++;
      } catch (error) {
        failures.push([target.key, url, String((error as Error).message)]);
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  mkdirSync(fileURLToPath(new URL(".", INDEX_FILE)), { recursive: true });
  writeFileSync(INDEX_FILE, `${JSON.stringify(targets, undefined, 1)}\n`);

  return { targets: targets.length, cached, bytes, failures };
}

export interface CachedSpec {
  readonly key: string;
  readonly html: string;
}

export function loadSpecIndex(): readonly SpecTarget[] {
  try {
    return JSON.parse(readFileSync(INDEX_FILE, "utf8")) as readonly SpecTarget[];
  } catch {
    throw new Error(
      `No cached spec index at ${fileURLToPath(INDEX_FILE)}. Run \`pnpm --filter @no-throw/dom-baseline-tools run fetch-specs\` first.`,
    );
  }
}

export function* loadCachedSpecs(): Generator<CachedSpec> {
  const dir = specCacheDir();
  let files: readonly string[];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith(".html")).sort();
  } catch {
    throw new Error(
      `No cached specs at ${dir}. Run \`pnpm --filter @no-throw/dom-baseline-tools run fetch-specs\` first.`,
    );
  }
  for (const name of files) {
    yield { key: name.slice(0, -".html".length), html: readFileSync(join(dir, name), "utf8") };
  }
}

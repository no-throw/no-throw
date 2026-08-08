import { readFileSync } from "node:fs";

import type { BaselineData, BaselineEntry } from "./types.js";

/**
 * The baseline ships as two files, split by which generator produced them —
 * ECMA-262 prose for one, WebIDL plus Bikeshed prose for the other. Splitting
 * them also keeps the DOM table, which is an order of magnitude larger, off the
 * heap of a program that has no `dom` in its `lib`.
 */
export type BaselineSource = "es" | "dom";

const FILES: Record<BaselineSource, URL> = {
  es: new URL("../../baseline-data/es.json", import.meta.url),
  dom: new URL("../../baseline-data/dom.json", import.meta.url),
};

const cached = new Map<BaselineSource, BaselineData>();

/**
 * One shipped baseline file. Generated data, read once. A missing or unreadable
 * file is a packaging defect rather than a user-facing condition: an empty
 * baseline would floor every builtin and look exactly like the tool being
 * broken, so it fails loudly instead.
 */
export function baselineData(source: BaselineSource): BaselineData {
  const hit = cached.get(source);
  if (hit !== undefined) return hit;
  const parsed = JSON.parse(readFileSync(FILES[source], "utf8")) as BaselineData;
  cached.set(source, parsed);
  return parsed;
}

/** Which file answers for a lib target. `dom.iterable` is DOM data too. */
export function sourceOfLibTarget(libTarget: string): BaselineSource {
  return libTarget === "dom" || libTarget.startsWith("dom.") ? "dom" : "es";
}

/**
 * The entry for one member of one lib target, or `undefined` — which the
 * caller must read as *floor*. A TypeScript release landing ahead of a
 * `@nothrow/core` release therefore floors its newcomers by construction.
 */
export function lookupBaselineEntry(
  libTarget: string,
  key: string,
): BaselineEntry | undefined {
  return baselineData(sourceOfLibTarget(libTarget)).libs[libTarget]?.[key];
}

const owners = new Map<BaselineSource, ReadonlySet<string>>();

/**
 * Whether the baseline enumerates the type a member is written on. The lib
 * target picks the file to ask; the answer is that file's, across every target
 * in it, because an interface merged across lib versions is one type.
 *
 * The generators walk what a global reaches — a prototype interface, a
 * constructor object — and nothing else, so `Error` is enumerated and
 * `IteratorYieldResult` is not. That boundary is what #29 §4's rule turns on:
 * absence may only be read as a floor where an enumeration was owed an answer.
 * An interface describing an object literal — a result bag, an options bag —
 * was owed none, and its declaration answers as any other hand-written one
 * does.
 */
export function baselineCoversOwner(libTarget: string, owner: string): boolean {
  const source = sourceOfLibTarget(libTarget);
  let known = owners.get(source);
  if (known === undefined) {
    known = ownersIn(baselineData(source));
    owners.set(source, known);
  }
  return known.has(owner);
}

/** Every type the shipped keys name: `Array#push` and `Response.json` both. */
function ownersIn(data: BaselineData): ReadonlySet<string> {
  const found = new Set<string>();
  for (const table of Object.values(data.libs)) {
    for (const key of Object.keys(table)) {
      const at = key.search(/[#.]/u);
      if (at > 0) found.add(key.slice(0, at));
    }
  }
  return found;
}

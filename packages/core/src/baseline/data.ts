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
 * `@no-throw/core` release therefore floors its newcomers by construction.
 */
export function lookupBaselineEntry(
  libTarget: string,
  key: string,
): BaselineEntry | undefined {
  return baselineData(sourceOfLibTarget(libTarget)).libs[libTarget]?.[key];
}

import { readFileSync } from "node:fs";

import type { BaselineData, BaselineEntry } from "./types.js";

const DATA_URL = new URL("../../baseline-data/es.json", import.meta.url);

let cached: BaselineData | undefined;

/**
 * The shipped ES baseline. Generated data, read once. A missing or unreadable
 * file is a packaging defect rather than a user-facing condition: an empty
 * baseline would floor every builtin and look exactly like the tool being
 * broken, so it fails loudly instead.
 */
export function baselineData(): BaselineData {
  if (cached === undefined) {
    cached = JSON.parse(readFileSync(DATA_URL, "utf8")) as BaselineData;
  }
  return cached;
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
  return baselineData().libs[libTarget]?.[key];
}

import {
  readConfigSafe, parseIntSafe, mustParse, fetchThing, fetchThingSafe,
} from "./lib";

// Call sites the rule must classify:

// 1. imported branded non-throwing call
const a = readConfigSafe("x");

// 2. imported JSDoc non-throwing call
const b = parseIntSafe("12");

// 3. imported throwing call, UNGUARDED (should be flagged in non-throwing code)
const c = mustParse("12");

// 4. imported throwing call, GUARDED by try/catch (the sanctioned bridge)
let d: number | null;
try {
  d = mustParse("12");
} catch {
  d = null;
}

// 5. awaited rejecting call, unguarded
export async function useAsyncUnsafe(id: string): Promise<string> {
  return await fetchThing(id);
}

// 6. awaited rejecting call, guarded
export async function useAsyncSafe(id: string): Promise<string | null> {
  try {
    return await fetchThing(id);
  } catch {
    return null;
  }
}

// 7. awaited branded-safe call
export async function useAsyncBranded(id: string): Promise<string | null> {
  return await fetchThingSafe(id);
}

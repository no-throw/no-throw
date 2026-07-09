// bridge.ts — CASE 2: the try/catch BRIDGE. A non-throwing function calls
// throwing code inside a catching try and converts the throw into a returned
// value without re-throwing. Expect: PASS.
import { mustBePositive } from './math';

/** @nothrow */
export function safePositive(n: number): number {
  try {
    return mustBePositive(n); // throwing call, but bridged
  } catch {
    return 0; // throw converted to a returned value; no rethrow
  }
}

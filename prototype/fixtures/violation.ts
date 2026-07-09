// violation.ts — CASE 3: the core violations. Both must be FLAGGED.
import { mustBePositive } from './math';

/** @nothrow */
export function bareCall(n: number): number {
  return mustBePositive(n); // VIOLATION: unbridged call to a throwing function
}

/** @nothrow */
export function bareThrow(n: number): number {
  if (n < 0) throw new Error('negative'); // VIOLATION: uncaught throw escapes
  return n;
}

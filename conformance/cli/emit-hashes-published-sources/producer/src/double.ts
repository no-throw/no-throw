import step from "./step.json" with { type: "json" };

/** @nothrow */
export function double(n: number): number {
  return n * step.by;
}

import { each, fetchOk, register, twice, widen } from "verified";

/** @nothrow */
const log = (error: unknown): void => {
  void error;
};

function risky(n: number): void {
  if (n > 0) throw n;
}

/** @nothrow */
export function doubles(): number {
  return twice(2);
}

/** @nothrow */
export function widensBoth(): string {
  return widen("one") + widen(2);
}

/** @nothrow */
export function fireAndForget(): void {
  fetchOk().catch(log);
}

/** @nothrow */
export function visitsCleanly(items: number[]): void {
  each(items, (item) => {
    void item;
  });
}

/** @nothrow */
export function visitsRiskily(items: number[]): void {
  each(items, risky);
}

/** @nothrow */
export function registersRisky(): void {
  register(() => {
    throw new Error("later");
  });
}

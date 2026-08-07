/** @nothrow */
export function dispatch(a: () => void, b: () => void, flag: boolean): void {
  const g = flag ? a : b;
  g();
}

/** @nothrow */
export function run(flag: boolean): void {
  dispatch(risky, clean, flag);
}

function risky(): void {
  JSON.parse("{}");
}

function clean(): void {
  ticks += 1;
}

let ticks = 0;

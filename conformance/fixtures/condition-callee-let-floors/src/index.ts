/** @nothrow */
export function run(flag: boolean): void {
  let g = clean;
  if (flag) g = risky;
  g();
}

function clean(): void {
  ticks += 1;
}

function risky(): void {
  JSON.parse("{}");
}

let ticks = 0;

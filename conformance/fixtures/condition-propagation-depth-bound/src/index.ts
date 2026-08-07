interface Chain {
  readonly a: Chain;
  readonly c: Chain;
  readonly b: { run(): void };
}

/** @nothrow */
export function f(x: Chain): void {
  g(x.a);
}

function g(y: Chain): void {
  y.b.run();
  f(y.c);
}

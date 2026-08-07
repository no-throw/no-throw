interface Expr {
  readonly value: number;
  readonly left: Expr | null;
  readonly right: Expr | null;
}

/** @nothrow */
export function evaluate(expr: Expr): number {
  return sum(expr);
}

function sum(expr: Expr): number {
  return expr.value + branch(expr.left) + branch(expr.right);
}

function branch(expr: Expr | null): number {
  return expr === null ? 0 : sum(expr);
}

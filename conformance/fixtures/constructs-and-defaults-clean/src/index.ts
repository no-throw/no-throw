class Point {
  x = 1;
  y: number;

  constructor(y = 2) {
    this.y = y;
  }
}

function label(parts: TemplateStringsArray, value: number): number {
  return value;
}

function scaled(factor = 2): number {
  return factor * 2;
}

/** @nothrow */
export function run(): number {
  const point = new Point();
  return point.x + label`n=${scaled()}` + point.y;
}

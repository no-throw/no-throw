function sql(parts: TemplateStringsArray, id: number): string {
  throw "boom";
}

/** @nothrow */
export function query(id: number): string {
  return sql`select ${id}`;
}

declare const loose: any;
declare const opaque: unknown;
declare const record: Record<string, number>;

/** @nothrow */
export function interpolate(): string {
  return `${loose}`;
}

/** @nothrow */
export function interpolateOpaque(): string {
  return `${opaque}`;
}

/** @nothrow */
export function read(): unknown {
  return loose.value;
}

/** @nothrow */
export function keyed(): number | undefined {
  return record[loose];
}

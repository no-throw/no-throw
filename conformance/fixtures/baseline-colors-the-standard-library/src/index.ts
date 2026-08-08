interface Config {
  readonly [key: string]: string;
}

/** @nothrow */
export function names(config: Config): string[] {
  return Object.keys(config);
}

/** @nothrow */
export function clean(text: string): string {
  return text.trim();
}

/** @nothrow */
export function parse(text: string): unknown {
  return JSON.parse(text);
}

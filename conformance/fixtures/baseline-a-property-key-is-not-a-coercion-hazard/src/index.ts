interface Config {
  readonly name: string;
}

/** @nothrow */
export function declares(config: Config, key: string): boolean {
  return Object.hasOwn(config, key);
}

/** @nothrow */
export function owns(config: Config, key: string): boolean {
  return config.hasOwnProperty(key);
}

/** @nothrow */
export function shows(config: Config, key: string): boolean {
  return config.propertyIsEnumerable(key);
}

/** @nothrow */
export function names(config: Config): string[] {
  return Object.keys(config);
}

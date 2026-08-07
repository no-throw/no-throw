const registry: Record<string, () => void> = {};

function store(name: string, handler: () => void): void {
  registry[name] = handler;
}

/** @nothrow */
export function register(name: string, handler: () => void): void {
  store(name, handler);
}

/** @nothrow */
export function install(): void {
  register("risky", risky);
}

function risky(): void {
  JSON.parse("{}");
}

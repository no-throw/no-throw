/** @nothrow */
export function parse(text: string): unknown {
  return JSON.parse(text);
}

/** @nothrow */
export function wrap(target: object, handler: ProxyHandler<object>): object {
  return new Proxy(target, handler);
}

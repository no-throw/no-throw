/** @nothrow */
export function wrap(target: object, handler: ProxyHandler<object>): object {
  return new Proxy(target, handler);
}

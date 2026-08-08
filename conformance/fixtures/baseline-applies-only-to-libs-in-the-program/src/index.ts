interface EventTarget {
  addEventListener(type: string, listener: () => void): void;
}

declare const target: EventTarget;

/** @nothrow */
export function listen(handler: () => void): void {
  target.addEventListener("click", handler);
}

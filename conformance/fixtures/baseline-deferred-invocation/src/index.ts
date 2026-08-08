function risky(): void {
  throw new Error("boom");
}

/** @nothrow */
export function listen(target: EventTarget): void {
  target.addEventListener("click", risky);
}

/** @nothrow */
export function listenInsideTry(target: EventTarget): void {
  try {
    target.addEventListener("click", risky);
  } catch {}
}

/** @nothrow */
export function defer(target: EventTarget, handler: () => void): void {
  target.addEventListener("click", handler);
}

import type { Wrapper } from "flaky";

declare const wrapper: Wrapper;

/** @nothrow */
export function readSize(): number {
  return wrapper.size;
}

/** @nothrow */
export function writeSize(): void {
  wrapper.size = 1;
}

/** @nothrow */
export function readTag(): string {
  return wrapper.tag;
}

/** @nothrow */
export function readCount(): number {
  return wrapper.count;
}

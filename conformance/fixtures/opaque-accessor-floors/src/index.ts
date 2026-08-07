declare class Remote {
  get value(): number;
  set value(next: number);
  data: number;
}

declare const remote: Remote;

/** @nothrow */
export function read(): number {
  return remote.value;
}

/** @nothrow */
export function write(): void {
  remote.value = 1;
}

/** @nothrow */
export function readData(): number {
  return remote.data;
}

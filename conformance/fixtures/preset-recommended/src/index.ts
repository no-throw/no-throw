/** @nothrow */
export function fail(): void {
  throw "boom";
}

/** @nothrow */
export type Handler = () => void;

export async function later(): Promise<void> {}

export function fireAndForget(): void {
  later();
}

import { createInterface } from "readline";

/** @nothrow */
export function shut(): void {
  const lines = createInterface();
  lines.close();
}

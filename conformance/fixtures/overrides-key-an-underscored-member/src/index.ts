import { api } from "underscored";

/** @nothrow */
export function internal(raw: string): string {
  return api.__decode(raw);
}

/** @nothrow */
export function published(raw: string): string {
  return api.decode(raw);
}

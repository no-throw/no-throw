/** @nothrow */
function initials(s: string): string {
  return s.substr(0, 1);
}

/** @nothrow */
export function caller(): string {
  return initials("abc");
}

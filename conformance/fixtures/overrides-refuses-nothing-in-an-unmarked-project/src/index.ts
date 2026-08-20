export function clean(text: string): string {
  return text.trim();
}

export function risky(text: string): unknown {
  return JSON.parse(text);
}

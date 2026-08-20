import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * ECMA-262's single-page draft. Cached rather than vendored: the generator is
 * maintainer-side and runs on demand, while both CI gates run over the
 * *generated* data and never need the spec at all.
 */
export const SPEC_URL = "https://tc39.es/ecma262/";

const CACHE_DIR = new URL("../../.cache/", import.meta.url);
const CACHE_FILE = new URL("spec.html", CACHE_DIR);

export function specCachePath(): string {
  return fileURLToPath(CACHE_FILE);
}

export async function fetchSpec(): Promise<number> {
  const response = await fetch(SPEC_URL);
  if (!response.ok) {
    throw new Error(`${SPEC_URL} responded ${response.status}`);
  }
  const html = await response.text();
  mkdirSync(fileURLToPath(CACHE_DIR), { recursive: true });
  writeFileSync(CACHE_FILE, html);
  return html.length;
}

export function loadSpecHtml(): string {
  try {
    return readFileSync(CACHE_FILE, "utf8");
  } catch {
    throw new Error(
      `No cached ECMA-262 spec at ${specCachePath()}. Run \`pnpm --filter @no-throw/es-baseline-tools run fetch-spec\` first.`,
    );
  }
}

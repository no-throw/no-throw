import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The target's own ESLint, TypeScript and typescript-eslint — not the
 * workspace's. Every arm runs on one install, so a delta between arms is the
 * rules and nothing else; and the absolute numbers are the ones that codebase's
 * CI actually pays.
 */
export async function hostModule<T>(
  targetDirectory: string,
  specifier: string,
): Promise<T> {
  const require = createRequire(join(targetDirectory, "package.json"));
  const resolved = require.resolve(specifier);
  return (await import(pathToFileURL(resolved).href)) as T;
}

export async function hostVersions(
  targetDirectory: string,
): Promise<Record<string, string>> {
  const require = createRequire(join(targetDirectory, "package.json"));
  const versions: Record<string, string> = {};
  for (const name of ["eslint", "typescript", "typescript-eslint"]) {
    try {
      const manifest = require(`${name}/package.json`) as { version: string };
      versions[name] = manifest.version;
    } catch {
      versions[name] = "absent";
    }
  }
  return versions;
}

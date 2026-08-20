import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The built plugin, addressed the way a config file in the *target's* tree has
 * to address it: an absolute URL, because nothing over there can resolve a
 * workspace package name. Resolved through the name rather than by walking up
 * to `packages/`, so the declared dependency is what the arm actually loads.
 */
const PLUGIN = import.meta.resolve("@no-throw/eslint-plugin");

export type EslintArm = "baseline" | "preset" | "preset-compat";

/** #4's lever, as the two values `NOTHROW_COLOR_POLICY` selects between. */
export type Policy = "hybrid" | "declare";

/**
 * Each arm as a config file in the target's own root, so `./eslint.config.mjs`
 * resolves and the base config's relative `project` paths keep working.
 *
 * `preset` is the preset a consumer installs, dropped in untouched. `preset-compat`
 * is the same thing with the `@typescript-eslint` registration taken out — the
 * shape a project that already registers that plugin needs, and the one that
 * makes the arms comparable when the untouched preset will not load.
 */
export function writeEslintConfigs(
  targetDirectory: string,
): Record<EslintArm, string> {
  const files: Record<EslintArm, string> = {
    baseline: join(targetDirectory, "dogfood.baseline.eslint.config.mjs"),
    preset: join(targetDirectory, "dogfood.preset.eslint.config.mjs"),
    "preset-compat": join(
      targetDirectory,
      "dogfood.preset-compat.eslint.config.mjs",
    ),
  };

  writeFileSync(files.baseline, 'export { default } from "./eslint.config.mjs";\n');

  writeFileSync(
    files.preset,
    [
      'import base from "./eslint.config.mjs";',
      `import nothrow from "${PLUGIN}";`,
      "",
      "export default [...base, nothrow.configs.recommended];",
      "",
    ].join("\n"),
  );

  writeFileSync(
    files["preset-compat"],
    [
      'import base from "./eslint.config.mjs";',
      `import nothrow from "${PLUGIN}";`,
      "",
      "const { plugins, ...preset } = nothrow.configs.recommended;",
      "",
      "export default [",
      "  ...base,",
      "  { ...preset, plugins: { nothrow: plugins.nothrow } },",
      "];",
      "",
    ].join("\n"),
  );

  return files;
}

import tseslint from "@typescript-eslint/eslint-plugin";
import type { FlatConfig } from "@typescript-eslint/utils/ts-eslint";
import { noEscapingThrow } from "./rules/no-escaping-throw.js";
import { validMark } from "./rules/valid-mark.js";

const plugin = {
  meta: { name: "@nothrow/eslint-plugin" },
  rules: {
    "no-escaping-throw": noEscapingThrow,
    "valid-mark": validMark,
  },
  // The preset names this same object, so it cannot be part of the literal
  // that creates it.
  configs: {} as { recommended: FlatConfig.Config },
};

/**
 * The complete contract, in one install: the invariant, mark hygiene, and the
 * float rule the async story leans on. Everything is an error because CI is
 * where the guarantee lives — a warning enforces nothing.
 *
 * Every rule in it is type-aware, and a type-aware rule handed a file with no
 * type information does not report — it throws out of ESLint. So the preset
 * carries its own scope rather than leaving one for the reader to remember:
 * dropped into a config unscoped, it has to survive `eslint .` in a project
 * whose root holds the `.js` that configures ESLint in the first place.
 */
plugin.configs.recommended = {
  name: "nothrow/recommended",
  files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
  plugins: {
    nothrow: plugin as unknown as FlatConfig.Plugin,
    "@typescript-eslint": tseslint as unknown as FlatConfig.Plugin,
  },
  rules: {
    "nothrow/no-escaping-throw": "error",
    "nothrow/valid-mark": "error",
    "@typescript-eslint/no-floating-promises": "error",
  },
};

export default plugin;
export { noEscapingThrow, validMark };

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
 */
plugin.configs.recommended = {
  name: "nothrow/recommended",
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

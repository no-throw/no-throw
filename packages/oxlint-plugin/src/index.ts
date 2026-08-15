import { noEscapingThrow } from "./rules/no-escaping-throw.js";
import { validMark } from "./rules/valid-mark.js";

/**
 * The plugin oxlint loads from `jsPlugins`. The name is the rule namespace, so
 * it is `nothrow` — the same prefix the ESLint preset registers — and the two
 * hosts agree on every rule name a reader might grep for.
 */
const plugin = {
  meta: { name: "nothrow" },
  rules: {
    "no-escaping-throw": noEscapingThrow,
    "valid-mark": validMark,
  },
};

export default plugin;
export { noEscapingThrow, validMark };

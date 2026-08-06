import { noEscapingThrow } from "./rules/no-escaping-throw.js";

const plugin = {
  meta: { name: "@nothrow/eslint-plugin" },
  rules: {
    "no-escaping-throw": noEscapingThrow,
  },
};

export default plugin;
export { noEscapingThrow };

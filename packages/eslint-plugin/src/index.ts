import type { FlatConfig } from "@typescript-eslint/utils/ts-eslint";
import { noEscapingThrow } from "./rules/no-escaping-throw.js";
import { validMark } from "./rules/valid-mark.js";

const plugin = {
  meta: { name: "@no-throw/eslint-plugin" },
  rules: {
    "no-escaping-throw": noEscapingThrow,
    "valid-mark": validMark,
  },
  // The preset names this same object, so it cannot be part of the literal
  // that creates it.
  configs: {} as {
    recommended: (typescriptEslint: FlatConfig.Plugin) => FlatConfig.Config;
  },
};

/** The rule the preset adds on top of ours, and so what the argument must carry. */
const FLOAT_RULE = "no-floating-promises";

/**
 * The preset registers a plugin under `@typescript-eslint`, and ESLint refuses
 * a namespace registered twice with two different objects. Whose object it is
 * therefore decides whether a config starts at all — so it is the consumer's,
 * handed over here, and the identity check passes because there is only ever
 * one object.
 *
 * That relocates the failure rather than removing it: passing the umbrella
 * `typescript-eslint` where its `.plugin` is meant registers a different object
 * again. The difference is that this one is an argument at a site the reader
 * just typed, so it is checked here and named, before ESLint sees a config.
 */
function refusalFor(typescriptEslint: unknown): string | undefined {
  if (typescriptEslint === null || typeof typescriptEslint !== "object") {
    return `received ${typescriptEslint === undefined ? "no argument" : `\`${String(typescriptEslint)}\``}`;
  }
  // Carrying the rule the preset turns on is the whole requirement, so it
  // decides acceptance on its own. Only once it has failed is there a wrong
  // object to describe.
  const rules: unknown = (typescriptEslint as { rules?: unknown }).rules;
  if (
    rules !== null &&
    typeof rules === "object" &&
    FLOAT_RULE in (rules as object)
  ) {
    return undefined;
  }
  // The umbrella carries the plugin rather than being it, and it is what a
  // reader reaches for first, so it gets its own sentence.
  if ("plugin" in typescriptEslint) {
    return "received the `typescript-eslint` umbrella package, whose plugin is `tseslint.plugin`";
  }
  return `received an object without a \`${FLOAT_RULE}\` rule`;
}

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
 *
 * Order is not load-bearing anywhere: flat config merges `plugins` across every
 * config matching a file and resolves rule names on the merged result, so this
 * may sit before or after the consumer's own typescript-eslint config.
 */
plugin.configs.recommended = (typescriptEslint) => {
  const refusal = refusalFor(typescriptEslint);
  if (refusal !== undefined) {
    throw new TypeError(
      `\`nothrow.configs.recommended\` takes typescript-eslint's plugin object — pass \`tseslint.plugin\`, or \`@typescript-eslint/eslint-plugin\` itself — so the preset registers the copy your config already uses. It ${refusal}.`,
    );
  }

  return {
    name: "nothrow/recommended",
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    plugins: {
      nothrow: plugin as unknown as FlatConfig.Plugin,
      "@typescript-eslint": typescriptEslint,
    },
    rules: {
      "nothrow/no-escaping-throw": "error",
      "nothrow/valid-mark": "error",
      [`@typescript-eslint/${FLOAT_RULE}`]: "error",
    },
  };
};

export default plugin;
export { noEscapingThrow, validMark };

// The `eslint` peer range on `@nothrow/eslint-plugin` names the ESLint majors a
// consumer may install the plugin against. Everything that holds the claim true
// enumerates it from here rather than restating it, so widening the claim
// widens what has to pass.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const pluginManifestPath = fileURLToPath(
  new URL("../packages/eslint-plugin/package.json", import.meta.url),
);

/** The declared range, one entry per major: `{ major: 9, range: "^9.0.0" }`. */
export function declaredMajors() {
  const { peerDependencies } = JSON.parse(
    readFileSync(pluginManifestPath, "utf8"),
  );
  const declared = peerDependencies?.eslint;
  if (declared === undefined) {
    throw new Error(
      `${pluginManifestPath}: no \`eslint\` peer dependency to read.`,
    );
  }

  return declared.split("||").map((leg) => {
    const range = leg.trim();
    const major = /^\^(\d+)\.\d+\.\d+$/.exec(range)?.[1];
    if (major === undefined) {
      throw new Error(
        `${pluginManifestPath}: peerDependencies.eslint is "${declared}", and "${range}" is not a caret range. The checks behind this claim enumerate it one major at a time, so write it as carets — "^9.0.0 || ^10.0.0".`,
      );
    }
    return { major: Number(major), range };
  });
}

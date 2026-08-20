// The `oxlint` peer range on `@no-throw/oxlint-plugin` names what a consumer
// may install the plugin against. Everything that holds the claim true reads
// it from here rather than restating it, so widening the claim widens what has
// to pass.
//
// One caret leg rather than the ESLint gate's list of majors: oxlint's JS
// plugin API is the alpha surface this adapter sits on, and the floor of the
// range is the release the suite actually runs — so the claim is "this minor
// and everything after it in the major", and the gate probes both edges of
// exactly that.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const pluginManifestPath = fileURLToPath(
  new URL("../packages/oxlint-plugin/package.json", import.meta.url),
);

/** The declared range and its edges: `{ range, floor, below }`. */
export function declaredRange() {
  const { peerDependencies } = JSON.parse(
    readFileSync(pluginManifestPath, "utf8"),
  );
  const declared = peerDependencies?.oxlint;
  if (declared === undefined) {
    throw new Error(
      `${pluginManifestPath}: no \`oxlint\` peer dependency to read.`,
    );
  }

  const parts = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(declared);
  if (parts === null) {
    throw new Error(
      `${pluginManifestPath}: peerDependencies.oxlint is "${declared}", and the checks behind this claim probe a caret range's two edges, so write it as one caret — "^1.78.0".`,
    );
  }

  const [, major, minor, patch] = parts.map(Number);
  if (minor === 0 && patch === 0) {
    throw new Error(
      `${pluginManifestPath}: peerDependencies.oxlint is "${declared}", whose floor has no version below it inside a registry this gate can ask. Name the excluded version by hand.`,
    );
  }

  return {
    range: declared,
    floor: `${major}.${minor}.${patch}`,
    // The nearest version the claim excludes. A caret floor excludes the whole
    // release before it, and probing `minor - 1` keeps the probe inside
    // versions that exist whenever the floor's own minor does.
    below: patch > 0 ? `${major}.${minor}.${patch - 1}` : `${major}.${minor - 1}.0`,
  };
}

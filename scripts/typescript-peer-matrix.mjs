// The suite half of the `typescript` peer claim. Bounding the range at
// TypeScript 7 is only half an answer — it says which versions a consumer may
// install, and something has to say the engine actually works on them. An
// install gate alone would reproduce the defect one major down: a version
// admitted by the range that nothing ever runs on.
//
// `pin` writes a pnpm override rather than editing the manifests that declare
// TypeScript: one lever moves every workspace project at once, so no project can
// be missed. An override necessarily moves the lockfile, so a pinned install is
// not a frozen one. It also rewrites peer ranges, which is why the install-time
// half is a separate gate and not something a leg could notice.
//
// `verify` is what keeps a leg from reporting green on a major it never ran.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { declaredMajors } from "./typescript-peer-range.mjs";

const rootManifestPath = fileURLToPath(
  new URL("../package.json", import.meta.url),
);
const resolvedTypeScriptPath = fileURLToPath(
  new URL("../conformance/node_modules/typescript/package.json", import.meta.url),
);

function claimed(argument) {
  const major = Number(argument);
  const found = declaredMajors().find((leg) => leg.major === major);
  if (found === undefined) {
    throw new Error(
      `TypeScript ${argument ?? "<missing>"} is not in the peer range, so a run on it would prove nothing about what the packages claim.`,
    );
  }
  return found;
}

function pin(argument) {
  const { range } = claimed(argument);

  const manifest = JSON.parse(readFileSync(rootManifestPath, "utf8"));
  manifest.pnpm = {
    ...manifest.pnpm,
    overrides: { ...manifest.pnpm?.overrides, typescript: range },
  };
  writeFileSync(rootManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(
    `Pinned the workspace to TypeScript ${range}. This edits the root manifest: install with --no-frozen-lockfile, and revert it when you are done.`,
  );
}

function verify(argument) {
  const { major } = claimed(argument);

  let resolved;
  try {
    resolved = JSON.parse(readFileSync(resolvedTypeScriptPath, "utf8")).version;
  } catch {
    throw new Error(
      `${resolvedTypeScriptPath}: no resolved typescript to check. Install before verifying.`,
    );
  }

  if (Number(resolved.split(".")[0]) !== major) {
    throw new Error(
      `The suite is about to run on typescript ${resolved}, not the TypeScript ${major} this leg is named for: the pin did not take, and the leg would report green on a major it never ran.`,
    );
  }

  console.log(`The suite will run on typescript ${resolved}.`);
}

const [command, argument] = process.argv.slice(2);

try {
  switch (command) {
    case "majors":
      console.log(JSON.stringify(declaredMajors().map((leg) => leg.major)));
      break;
    case "pin":
      pin(argument);
      break;
    case "verify":
      verify(argument);
      break;
    default:
      throw new Error(
        "Usage: typescript-peer-matrix.mjs majors | pin <major> | verify <major>",
      );
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

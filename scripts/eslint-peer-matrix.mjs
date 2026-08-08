// The conformance matrix runs the whole suite once per ESLint major the plugin
// claims, and this is how a leg gets the major it is named for.
//
// `pin` writes a pnpm override rather than editing the manifests that declare
// eslint: one lever moves every workspace project at once, so no project can be
// missed. An override necessarily moves the lockfile, so a pinned install is not
// a frozen one — the drift check `--frozen-lockfile` buys stays in the jobs that
// do not lint. It also rewrites peer ranges, which is why the install-time half
// of the claim is a separate gate and not something a leg could notice.
//
// `verify` is what keeps a leg from reporting green on a major it never ran: an
// override that stopped taking would leave every leg on the locked version, and
// nothing else in the run would say so.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { declaredMajors } from "./eslint-peer-range.mjs";

const rootManifestPath = fileURLToPath(
  new URL("../package.json", import.meta.url),
);
const resolvedEslintPath = fileURLToPath(
  new URL("../conformance/node_modules/eslint/package.json", import.meta.url),
);

function claimed(argument) {
  const major = Number(argument);
  const found = declaredMajors().find((leg) => leg.major === major);
  if (found === undefined) {
    throw new Error(
      `ESLint ${argument ?? "<missing>"} is not in the peer range, so a run on it would prove nothing about what the plugin claims.`,
    );
  }
  return found;
}

function pin(argument) {
  const { major, range } = claimed(argument);

  const manifest = JSON.parse(readFileSync(rootManifestPath, "utf8"));
  manifest.pnpm = {
    ...manifest.pnpm,
    overrides: { ...manifest.pnpm?.overrides, eslint: range },
  };
  writeFileSync(rootManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(
    `Pinned the workspace to ESLint ${range}. This edits the root manifest: install with --no-frozen-lockfile, and revert it when you are done.`,
  );
}

function verify(argument) {
  const { major } = claimed(argument);

  let resolved;
  try {
    resolved = JSON.parse(readFileSync(resolvedEslintPath, "utf8")).version;
  } catch {
    throw new Error(
      `${resolvedEslintPath}: no resolved eslint to check. Install before verifying.`,
    );
  }

  if (Number(resolved.split(".")[0]) !== major) {
    throw new Error(
      `The suite is about to run on eslint ${resolved}, not the ESLint ${major} this leg is named for: the pin did not take, and the leg would report green on a major it never ran.`,
    );
  }

  console.log(`The suite will run on eslint ${resolved}.`);
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
        "Usage: eslint-peer-matrix.mjs majors | pin <major> | verify <major>",
      );
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

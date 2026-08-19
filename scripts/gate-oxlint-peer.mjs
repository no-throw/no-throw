// The defect a wrong `oxlint` peer range causes is an install-time one: a
// consumer on an excluded release gets an unmet-peer warning, or an outright
// failure under `strict-peer-dependencies=true`. The conformance suite runs
// one oxlint and cannot catch it, so this installs what would be published,
// the way a consumer installs it, on the range's two edges.
//
//   node scripts/gate-oxlint-peer.mjs
//   node scripts/gate-oxlint-peer.mjs --self-check
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installConsumer, pack } from "./consumer-install.mjs";
import { declaredRange } from "./oxlint-peer-range.mjs";

function install(oxlint, tarballs) {
  return installConsumer({
    dependencies: {
      "@no-throw/oxlint-plugin": `file:${tarballs.plugin}`,
      oxlint,
      typescript: "^5.7.2",
    },
    // `@no-throw/core` is a sibling at a version no registry has yet, so the
    // consumer has to be told where it is. Overriding it leaves the `oxlint`
    // peer this gate is about resolved the way a real install would resolve it.
    overrides: { "@no-throw/core": `file:${tarballs.core}` },
  });
}

function run() {
  const { range, floor, below } = declaredRange();
  const workspace = mkdtempSync(join(tmpdir(), "nothrow-peer-tarballs-"));

  try {
    const tarballs = {
      core: pack("packages/core", workspace),
      plugin: pack("packages/oxlint-plugin", workspace),
    };

    if (!process.argv.includes("--self-check")) {
      // The floor exactly, and the range's own resolution — the oldest install
      // the claim admits and the one a consumer gets today.
      for (const version of [floor, range]) {
        const { refused, output } = install(version, tarballs);
        if (refused) {
          throw new Error(
            `The plugin claims oxlint ${range}, and a consumer installing it with oxlint ${version} was refused:\n${output}`,
          );
        }
        console.log(`oxlint ${version}: installs clean under strict peers.`);
      }
      return;
    }

    // A gate that cannot fail is not a gate: the release just below the floor
    // is one the claim excludes, so a consumer on it must be refused, and
    // refused over *our* peer rather than something incidental.
    const { refused, output } = install(below, tarballs);
    if (!refused) {
      throw new Error(
        `oxlint ${below} is outside the declared range and a consumer installed on it anyway: this gate cannot fail.`,
      );
    }
    if (!output.includes("@no-throw/oxlint-plugin")) {
      throw new Error(
        `oxlint ${below} was refused, but not over our peer, so the gate would pass for the wrong reason:\n${output}`,
      );
    }

    console.log(
      `Self-check OK: a consumer on the excluded oxlint ${below} is refused over the plugin's own peer.`,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

try {
  run();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

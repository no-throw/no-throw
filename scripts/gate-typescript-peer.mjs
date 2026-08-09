// The install-time half of the `typescript` peer claim, which no suite run can
// answer: the matrix resolves its TypeScript through a pnpm override, and an
// override rewrites peer ranges, so no conflict survives to be reported.
//
// This installs what would be published, the way a consumer installs it, once
// per claimed major — and, under `--self-check`, on the major the range
// excludes.
//
//   node scripts/gate-typescript-peer.mjs
//   node scripts/gate-typescript-peer.mjs --self-check
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installConsumer, pack } from "./consumer-install.mjs";
import {
  declaredMajors,
  declaredRange,
  declaringPackages,
  excludedMajor,
} from "./typescript-peer-range.mjs";

const CORE = "@no-throw/core";

function run() {
  const packages = declaringPackages();
  const workspace = mkdtempSync(join(tmpdir(), "nothrow-ts-peer-tarballs-"));

  try {
    const tarballs = new Map(
      packages.map(({ name, directory }) => [name, pack(directory, workspace)]),
    );

    if (!tarballs.has(CORE)) {
      throw new Error(
        `${CORE} declares no \`typescript\` peer, so it was not packed. The self-check is built around it being the one package with no dependencies of its own, and needs rewriting before that stops being true.`,
      );
    }

    // The packages depend on each other at `workspace:*`, which no registry can
    // resolve. Overriding the sibling leaves the `typescript` peer this gate is
    // about resolved the way a real install would resolve it.
    const overrides = { [CORE]: `file:${tarballs.get(CORE)}` };

    if (process.argv.includes("--self-check")) {
      selfCheck(tarballs);
      return;
    }

    for (const { major, range } of declaredMajors()) {
      const { refused, output } = installConsumer({
        dependencies: {
          ...Object.fromEntries(
            [...tarballs].map(([name, tarball]) => [name, `file:${tarball}`]),
          ),
          typescript: range,
        },
        overrides,
      });
      if (refused) {
        throw new Error(
          `The packages claim TypeScript ${major}, and a consumer installing them on TypeScript ${major} was refused:\n${output}`,
        );
      }
      console.log(`TypeScript ${major}: installs clean under strict peers.`);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

// A gate that cannot fail is not a gate: the major above the range is one the
// claim excludes, so a consumer on it must be refused, and refused over *our*
// peer rather than something incidental.
//
// `@no-throw/core` alone is what makes that second half checkable. pnpm reports
// an unmet peer as the dependency *path* that reached it, so a consumer holding
// several of these packages names all of them in the failure whichever one
// actually refused — an assertion over that output would pass for the wrong
// reason. Core has no dependencies, so nothing else in the tree can be the
// refuser. What carries the result to its siblings is not this install but
// `declaredRange`, which has already refused to report a range they do not all
// declare, and refused a package that reaches for the compiler and declares none.
function selfCheck(tarballs) {
  const excluded = excludedMajor();

  const { refused, output } = installConsumer({
    dependencies: {
      [CORE]: `file:${tarballs.get(CORE)}`,
      typescript: `^${excluded}.0.0`,
    },
  });

  if (!refused) {
    throw new Error(
      `The packages declare "${declaredRange()}", and a consumer installed ${CORE} on TypeScript ${excluded} anyway. That is the failure this range exists to prevent: the peer is satisfied, the compiler API is absent, and the crash lands at the first rule run.`,
    );
  }
  if (!output.includes(CORE)) {
    throw new Error(
      `A consumer on TypeScript ${excluded} was refused, but not over ${CORE}'s own peer, so this gate would pass for the wrong reason:\n${output}`,
    );
  }

  console.log(
    `Self-check OK: a consumer on the excluded TypeScript ${excluded} is refused over ${CORE}'s own peer.`,
  );
}

try {
  run();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

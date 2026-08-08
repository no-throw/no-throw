// Nothing is published yet, so a consumer project can only install from local
// tarballs — and `pnpm pack` rewrites `@nothrow/core: workspace:*` into a
// registry spec that resolves nowhere, so the tarballs alone do not work
// either. This packs them and prints the recipe that does, so adoption testing
// against a foreign repo is reproducible rather than folklore.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const packagesDir = join(repoRoot, "packages");
const packDestination = join(repoRoot, "local-packs");

// The one package a consumer installs directly; everything else it needs
// reaches it as a dependency, through an override.
const entryPoint = "@nothrow/eslint-plugin";

// The parser the README's wiring imports. Nothing declares it a peer, so no
// install resolves it on the consumer's behalf.
const parserPackage = "typescript-eslint";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArguments(argv) {
  const options = { check: false, selfCheck: false };
  for (const argument of argv) {
    // `pnpm run pack:local -- --check` forwards the separator too.
    if (argument === "--") continue;
    if (argument === "--check") options.check = true;
    else if (argument === "--self-check") options.selfCheck = options.check = true;
    else fail(`Unknown argument: ${argument}\nUsage: pack-local [--check] [--self-check]`);
  }
  return options;
}

/** A path reaches a consumer through JSON and a shell, so it travels
 * forward-slashed; `path.resolve` reads a `C:/…` spec as absolute all the same. */
function slashed(path) {
  return path.replaceAll("\\", "/");
}

function fileSpec(tarball) {
  return `file:${slashed(tarball)}`;
}

/** A checkout can live under a path with a space, and these words are both
 * pasted into a shell and handed to one. */
function shellQuote(word) {
  return /\s/.test(word) ? `"${word}"` : word;
}

function run(command, args, { cwd, capture = false, allowFailure = false } = {}) {
  // `shell: true` because pnpm is a `.cmd` shim on Windows, which Node refuses
  // to spawn directly — so command and arguments both have to survive a shell.
  const result = spawnSync(shellQuote(command), args.map(shellQuote), {
    cwd,
    shell: true,
    encoding: "utf8",
    stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
  });
  if (result.error) fail(`Could not run \`${command}\`: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    fail(`\`${command} ${args.join(" ")}\` failed with exit code ${result.status}.`);
  }
  return { status: result.status, stdout: result.stdout ?? "" };
}

function readManifest(...path) {
  return JSON.parse(readFileSync(join(...path, "package.json"), "utf8"));
}

function readPublishablePackages() {
  const packages = readdirSync(packagesDir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => {
      const dir = join(packagesDir, dirent.name);
      return { dir, manifest: readManifest(dir) };
    })
    .filter(({ manifest }) => manifest.private !== true);
  if (packages.length === 0) fail(`No publishable packages under ${packagesDir}.`);
  return packages;
}

function pack(packages) {
  // Wiped rather than added to, so a package that has since been renamed or
  // made private cannot leave a stale tarball here looking current.
  rmSync(packDestination, { recursive: true, force: true });
  mkdirSync(packDestination, { recursive: true });
  return packages.map((pkg) => {
    // `pnpm pack` has no `--recursive`, and prints the tarball it wrote — which
    // beats reproducing npm's scope-flattening filename convention here.
    const { stdout } = run("pnpm", ["pack", "--pack-destination", packDestination], {
      cwd: pkg.dir,
      capture: true,
    });
    const tarball = stdout.trim().split(/\r?\n/).at(-1);
    if (!tarball) fail(`\`pnpm pack\` printed no tarball path for ${pkg.manifest.name}.`);
    return { ...pkg, tarball };
  });
}

function buildRecipe(packed) {
  const byName = new Map(packed.map((pkg) => [pkg.manifest.name, pkg]));

  // Every edge between two packed packages is a rewritten registry spec that
  // resolves nowhere, so each one needs redirecting. Derived rather than
  // listed, so a new internal edge cannot silently break the recipe. Dev
  // dependencies are absent from a tarball's install, so they need nothing.
  const overrides = {};
  for (const { manifest } of packed) {
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        const dependency = byName.get(name);
        if (dependency) overrides[name] = fileSpec(dependency.tarball);
      }
    }
  }

  const installed = byName.get(entryPoint);
  if (!installed) fail(`${entryPoint} is not among the packed packages.`);

  return {
    overrides,
    installed,
    alsoPacked: packed.filter((pkg) => pkg !== installed),
    spec: fileSpec(installed.tarball),
    peers: Object.entries(installed.manifest.peerDependencies ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  };
}

function printRecipe(packed, recipe) {
  const width = Math.max(...packed.map(({ manifest }) => manifest.name.length));
  console.log(`\nPacked ${packed.length} packages into ${slashed(packDestination)}:\n`);
  for (const { manifest, tarball } of packed) {
    console.log(`  ${manifest.name.padEnd(width)}  ${slashed(tarball)}`);
  }

  console.log(`
Nothing is published to npm yet, so a consumer needs both halves of this.

1. In the consumer's package.json. \`pnpm pack\` rewrote the workspace protocol
   to a registry spec that resolves nowhere; this points it back at the tarball
   sitting next to it:
`);
  console.log(indent(JSON.stringify({ pnpm: { overrides: recipe.overrides } }, null, 2), 2));

  console.log(`
2. Then, in the consumer:

  pnpm add -D ${shellQuote(recipe.spec)}

  # the parser the README's eslint.config.js imports — nothing declares it a
  # peer, so add it unless the repo already lints with it
  pnpm add -D ${parserPackage}

Nothing else. The plugin's peers are the target repo's own —

${indent(recipe.peers.map(([name, range]) => `${name} ${range}`).join("\n"), 2)}

— and pnpm's \`auto-install-peers\` supplies any that are missing. Do not pin
them here, or you will be testing against a toolchain the repo does not use.

\`@nothrow/cli\` is packed too — add its tarball the same way for the
\`nothrow\` binary.

Re-run this after any change to the packages, then re-run the \`pnpm add\` line
so the consumer picks up the new tarballs. Drop the overrides block once the
scope is published.`);
}

function indent(text, spaces) {
  const padding = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => padding + line)
    .join("\n");
}

const PLUGIN_PROBE = `
import plugin from "@nothrow/eslint-plugin";

const rules = Object.keys(plugin.configs.recommended.rules ?? {});
for (const rule of ["nothrow/no-escaping-throw", "nothrow/valid-mark"]) {
  if (!rules.includes(rule)) {
    console.error("configs.recommended is missing " + rule + "; it has: " + rules.join(", "));
    process.exit(1);
  }
}

console.log("The installed plugin loads and configs.recommended is intact.");
`;

// The issue this script answers is that the failure arrives before the user has
// seen a single diagnostic. Loading the plugin is not that bar; producing one
// from the README's own wiring is.
const LINT_PROBE = `
import { ESLint } from "eslint";

const results = await new ESLint().lintFiles(["src/index.ts"]);
const reported = results.flatMap((result) => result.messages.map((message) => message.ruleId));

if (!reported.includes("nothrow/no-escaping-throw")) {
  console.error("The marked throw was not reported. Rules that fired: " + (reported.join(", ") || "none"));
  process.exit(1);
}

console.log("Linting with the README's wiring reports the escaping throw.");
`;

// The engine reads its baselines off disk on first use, so a tarball missing
// `baseline-data` imports cleanly and then floors every builtin — which looks
// exactly like the tool being broken. Importing core is not enough; read them.
const CORE_PROBE = `
import { baselineData } from "@nothrow/core/baseline";

for (const source of ["es", "dom"]) {
  const libs = Object.keys(baselineData(source).libs ?? {});
  if (libs.length === 0) {
    console.error("The " + source + " baseline shipped with no lib targets.");
    process.exit(1);
  }
  console.log("The " + source + " baseline reads: " + libs.length + " lib targets.");
}
`;

const CONSUMER_SOURCE = `
/** @nothrow */
export function fail(): void {
  throw new Error("boom");
}
`;

const CONSUMER_ESLINT_CONFIG = `
import nothrow from "@nothrow/eslint-plugin";
import tseslint from "typescript-eslint";

export default [
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true },
    },
  },
  nothrow.configs.recommended,
];
`;

const CONSUMER_TSCONFIG = {
  compilerOptions: {
    strict: true,
    target: "ES2022",
    module: "Preserve",
    moduleDetection: "force",
    noEmit: true,
    skipLibCheck: true,
  },
  include: ["src"],
};

function write(dir, name, contents) {
  mkdirSync(join(dir, name, ".."), { recursive: true });
  writeFileSync(join(dir, name), contents.trimStart());
}

function probe(dir, name, source) {
  write(dir, name, source);
  run(process.execPath, [name], { cwd: dir });
}

/**
 * A greenfield project has no toolchain for the plugin's peers to attach to,
 * and installing them by bare name resolves versions no `@typescript-eslint`
 * release supports. So the check installs the versions this workspace itself
 * runs the plugin under — the plugin's own dev dependencies, and the parser
 * from the conformance suite, which is the thing here that drives ESLint.
 */
function workspaceToolchain(pluginDir) {
  const sources = [
    readManifest(pluginDir).devDependencies ?? {},
    readManifest(repoRoot, "conformance").dependencies ?? {},
  ];
  return ["@typescript-eslint/eslint-plugin", "eslint", "typescript", parserPackage].map((name) => {
    const range = sources.map((declared) => declared[name]).find(Boolean);
    if (!range) fail(`No workspace manifest declares ${name}; the check has no toolchain to install.`);
    return `${name}@${range}`;
  });
}

/**
 * Installs the printed recipe into a throwaway consumer outside the workspace,
 * then lints with the README's wiring — so what is verified is the text a user
 * pastes, all the way to a diagnostic. Every other packed tarball is opened
 * afterwards, since each is one a user may reach for.
 *
 * `--self-check` drops the overrides block and requires the install to fail:
 * without it this gate would pass on a recipe that fixes nothing.
 */
function check(recipe, { selfCheck }) {
  const dir = join(tmpdir(), "nothrow-local-install-check");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const manifest = {
    name: "nothrow-local-install-check",
    version: "0.0.0",
    private: true,
    type: "module",
    ...(selfCheck ? {} : { pnpm: { overrides: recipe.overrides } }),
  };
  write(dir, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(
    `\nInstalling into ${slashed(dir)}${selfCheck ? " without the overrides block" : ""}…\n`,
  );
  const install = run("pnpm", ["add", "-D", recipe.spec], { cwd: dir, allowFailure: true });

  if (selfCheck) {
    if (install.status === 0) {
      fail(
        "\nself-check FAILED: the install succeeded without the overrides block, so\n" +
          "the check proves nothing. Either the scope is published now — in which case\n" +
          "none of this is needed — or the recipe is not what makes the install work.",
      );
    }
    console.log("\nself-check OK: without the overrides block the install fails, as it must.");
    return;
  }

  if (install.status !== 0) {
    fail("\ncheck FAILED: the printed recipe does not install. See the pnpm output above.");
  }
  probe(dir, "probe-plugin.mjs", PLUGIN_PROBE);

  run("pnpm", ["add", "-D", ...workspaceToolchain(recipe.installed.dir)], { cwd: dir });
  write(dir, "tsconfig.json", `${JSON.stringify(CONSUMER_TSCONFIG, null, 2)}\n`);
  write(dir, "eslint.config.js", CONSUMER_ESLINT_CONFIG);
  write(dir, "src/index.ts", CONSUMER_SOURCE);
  probe(dir, "probe-lint.mjs", LINT_PROBE);

  run("pnpm", ["add", "-D", ...recipe.alsoPacked.map(({ tarball }) => fileSpec(tarball))], { cwd: dir });
  probe(dir, "probe-core.mjs", CORE_PROBE);
  const usage = run("pnpm", ["exec", "nothrow"], { cwd: dir, capture: true, allowFailure: true });
  // `nothrow` has no implemented command yet, so it always exits non-zero; what
  // is under test is that the bin is wired and runs at all.
  if (!usage.stdout.includes("nothrow —")) {
    fail(`\ncheck FAILED: the \`nothrow\` binary printed no usage.\n${usage.stdout}`);
  }
  console.log("The `nothrow` binary runs.");

  console.log("\ncheck OK: every packed tarball installs into a foreign project and works.");
}

const options = parseArguments(process.argv.slice(2));

run("pnpm", ["run", "build"], { cwd: repoRoot });

const packed = pack(readPublishablePackages());
const recipe = buildRecipe(packed);
printRecipe(packed, recipe);

if (options.check) check(recipe, options);

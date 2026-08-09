// The `typescript` peer range names the TypeScript versions a consumer may
// install the published packages against. Everything that holds the claim true
// enumerates it from here rather than restating it, so widening the claim widens
// what has to pass.
//
// The upper bound is the load-bearing half. TypeScript 7 ships the compiler as a
// Go binary and deliberately ships no programmatic API — its `exports` map
// resolves `typescript` to a module carrying the version and nothing else. So
// `import ts from "typescript"` still succeeds, every entry point the engine
// calls is `undefined`, and an unbounded range turns that into a satisfied
// install followed by `ts.createProgram is not a function` at the first rule
// run. Bounding it puts the failure at install time, where a version conflict
// can still be read and acted on.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packagesDirectory = fileURLToPath(
  new URL("../packages/", import.meta.url),
);

// A floor, and a ceiling on a major boundary. The ceiling has to land on one:
// the matrix and the gate both consume this claim a major at a time, and a
// ceiling mid-major would leave a major that is neither wholly claimed nor
// wholly excluded, so neither could say what to do with it.
const RANGE = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)\.0\.0$/;

const IMPORTS_TYPESCRIPT = /(?:from|require\()\s*["']typescript["']/;

function sourceFiles(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/**
 * Whether a package's own source reaches for the compiler. A type-only import
 * counts: it erases at runtime, but it puts `ts.*` types in the `.d.ts` the
 * package publishes, and a consumer type-checking against those needs a
 * compatible compiler just as much.
 */
function usesTypeScript(packageDirectory) {
  return sourceFiles(join(packageDirectory, "src")).some((path) =>
    IMPORTS_TYPESCRIPT.test(readFileSync(path, "utf8")),
  );
}

/**
 * Every published package that declares a `typescript` peer — and a refusal if
 * one reaches for the compiler without declaring it. Nothing downstream would
 * notice that package: it would simply not appear in the claim, so a consumer
 * would install it against any compiler at all, which is where this started.
 */
export function declaringPackages() {
  const packages = readdirSync(packagesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = join(packagesDirectory, entry.name);
      const json = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      );
      return {
        directory: `packages/${entry.name}`,
        name: json.name,
        declared: json.peerDependencies?.typescript,
        uses: usesTypeScript(directory),
      };
    });

  const undeclared = packages.filter(
    ({ declared, uses }) => uses && declared === undefined,
  );
  if (undeclared.length > 0) {
    throw new Error(
      `These packages import the TypeScript compiler and declare no \`typescript\` peer dependency, so nothing bounds what a consumer may install them against:\n${undeclared
        .map(({ name }) => `  ${name}`)
        .join("\n")}`,
    );
  }

  return packages.filter(({ declared }) => declared !== undefined);
}

/**
 * The one range all of them declare. They have to agree: a consumer installing
 * two of these packages gets the intersection of what they declare, and an
 * intersection nobody wrote down is a claim nobody checked. This is also what
 * makes one package's behavior evidence about the others, which is what lets
 * the gate's self-check stay a single unambiguous install.
 */
export function declaredRange() {
  const declaring = declaringPackages();
  if (declaring.length === 0) {
    throw new Error(
      `${packagesDirectory}: no package declares a \`typescript\` peer dependency, so there is no claim to check.`,
    );
  }

  const ranges = new Set(declaring.map(({ declared }) => declared));
  if (ranges.size > 1) {
    const listed = declaring
      .map(({ name, declared }) => `  ${name}: "${declared}"`)
      .join("\n");
    throw new Error(
      `The published packages disagree about which TypeScript versions they support:\n${listed}\nA consumer installing more than one gets the intersection, which is a claim nothing here checks. Declare one range.`,
    );
  }

  return [...ranges][0];
}

/**
 * The claimed range, one entry per major: `{ major: 6, range: "^6.0.0" }`. The
 * floor's own major carries the floor rather than the whole major, so a range
 * that starts mid-major is not silently widened by the thing that checks it.
 */
export function declaredMajors() {
  const declared = declaredRange();
  const match = RANGE.exec(declared);
  if (match === null) {
    throw new Error(
      `The \`typescript\` peer range is "${declared}", which this cannot enumerate. Write it as a floor and a ceiling on a major boundary — ">=5.0.0 <7.0.0".`,
    );
  }

  const [, floorMajor, floorMinor, floorPatch, ceiling] = match;
  const floor = Number(floorMajor);
  const excluded = Number(ceiling);
  if (excluded <= floor) {
    throw new Error(
      `The \`typescript\` peer range is "${declared}", which claims nothing: the ceiling is at or below the floor.`,
    );
  }

  const majors = [];
  for (let major = floor; major < excluded; major += 1) {
    majors.push({
      major,
      range:
        major === floor
          ? `^${floorMajor}.${floorMinor}.${floorPatch}`
          : `^${major}.0.0`,
    });
  }
  return majors;
}

/**
 * The first major the range excludes — what the gate's self-check installs. A
 * gate that cannot fail is not a gate, and for this claim the version that must
 * be refused is the one the whole bound exists for.
 */
export function excludedMajor() {
  return declaredMajors().at(-1).major + 1;
}

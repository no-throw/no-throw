import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";

/**
 * The npm package a file ships in, found the one way the design sanctions:
 * ascend to the first `package.json` that **names a package** and stop there.
 * "Package" enters the design only here, in the escape hatch's discovery
 * walk-up — nothing merges across a boundary, and a directory is answered once
 * and cached.
 */
export interface PackageHome {
  /** The directory holding the `package.json` the walk stopped at. */
  readonly directory: string;
  readonly name: string | undefined;
  /**
   * The npm export subpath the package publishes, to the files it publishes
   * there. The subpath is the first half of a manifest key, and these files are
   * where the public names that make up the second half are read from — not the
   * files those names happen to be declared in.
   */
  readonly entryPoints: ReadonlyMap<string, readonly string[]>;
}

const homes = new Map<string, PackageHome | undefined>();

/** The package a file belongs to, or nothing where the walk found none. */
export function packageHomeOf(fileName: string): PackageHome | undefined {
  return homeOfDirectory(dirname(normalize(fileName)));
}

/** Whether two files ship in the same npm package. */
export function sameHome(
  a: PackageHome | undefined,
  b: PackageHome | undefined,
): boolean {
  return a !== undefined && b !== undefined && a.directory === b.directory;
}

function homeOfDirectory(directory: string): PackageHome | undefined {
  const known = homes.get(directory);
  if (known !== undefined || homes.has(directory)) return known;

  const home = buildHome(directory);
  homes.set(directory, home);
  return home;
}

function buildHome(directory: string): PackageHome | undefined {
  const manifestPath = join(directory, "package.json");
  const packageJson = existsSync(manifestPath)
    ? readJson(manifestPath)
    : undefined;
  const name =
    typeof packageJson?.["name"] === "string" ? packageJson["name"] : undefined;

  // A `package.json` naming no package is a module-format marker — the
  // `{ "type": "module" }` file a dual-published package drops beside one of
  // its builds — and a format scope is not a package boundary. Identity is
  // what this walk answers, so it reads past one: stopping there would file
  // every declaration under that build under no npm name at all, and a carrier
  // is matched by npm name and by nothing else.
  if (name === undefined) {
    const above = homeAbove(directory);
    if (above !== undefined) return above;
  }

  return packageJson === undefined
    ? undefined
    : { directory, name, entryPoints: entryPoints(directory, packageJson) };
}

/**
 * The home of the directory above, where there is an above to ask.
 * `node_modules` is where the ascent stops: everything over it belongs to the
 * *consumer*, and an unnamed dependency answered with the asking project's
 * home would be read as your own source rather than as somebody else's.
 */
function homeAbove(directory: string): PackageHome | undefined {
  const parent = dirname(directory);
  return parent === directory || basename(parent) === "node_modules"
    ? undefined
    : homeOfDirectory(parent);
}

/**
 * The subpaths the package publishes, each with the files published there.
 * `exports` is authoritative where it exists; the legacy `types`/`typings`/
 * `main` trio answers for packages predating it.
 *
 * There is nothing to gain from consulting `types` beside an `exports` that
 * does not name declarations: TypeScript resolves such a package to no
 * declaration file at all — it reports the types it can see and declines to
 * use them — so the file would not be in the program to be found.
 */
function entryPoints(
  directory: string,
  packageJson: Record<string, unknown> | undefined,
): ReadonlyMap<string, readonly string[]> {
  const points = new Map<string, string[]>();
  const add = (subpath: string, files: readonly string[]): void => {
    const found = files.map((file) => normalize(join(directory, file)));
    if (found.length === 0) return;
    points.set(subpath, [...(points.get(subpath) ?? []), ...found]);
  };

  const exported = packageJson?.["exports"];
  if (typeof exported === "string" || Array.isArray(exported)) {
    add(".", exportTargets(exported));
  } else if (isRecord(exported)) {
    // `{ ".": … }` is a subpath map; anything else is the sugar form, one set
    // of conditions for the root.
    const subpaths = Object.keys(exported).filter((key) => key.startsWith("."));
    if (subpaths.length === Object.keys(exported).length) {
      for (const subpath of subpaths) {
        add(subpath, exportTargets(exported[subpath]));
      }
    } else {
      add(".", exportTargets(exported));
    }
  }

  // The legacy trio is read as what it is: a path relative to the package,
  // written however its author wrote it. `exports` is the field that requires
  // the `./`, and holding these to it drops the spelling most of npm predating
  // `exports` actually ships — `"main": "out/index.js"` — leaving the package
  // with no entry point, no surface, and no key any carrier could reach.
  if (points.size === 0) {
    for (const field of ["types", "typings", "main"]) {
      const named = packageJson?.[field];
      if (typeof named === "string" && named.length > 0) add(".", [named]);
    }
  }

  return points;
}

/**
 * Every file an `exports` value can bottom out in. Node requires a target to
 * be relative and spelled with the `./`, so anything else is a condition value
 * this reader has no file to take from — `null`, or a bare specifier.
 */
function exportTargets(target: unknown): readonly string[] {
  if (typeof target === "string") return target.startsWith(".") ? [target] : [];
  if (Array.isArray(target)) return target.flatMap(exportTargets);
  if (isRecord(target)) return Object.values(target).flatMap(exportTargets);
  return [];
}

export function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    // Unreadable and malformed are the same thing to every reader here: the
    // file says nothing, so nothing is taken from it.
    return undefined;
  }
}

export function join(directory: string, relativePath: string): string {
  return resolve(directory, relativePath);
}

/**
 * One spelling for a path, so a file named by a `package.json` and the same
 * file named by the checker compare equal. TypeScript spells separators
 * forward, Node spells them per platform, and Windows is case-insensitive.
 */
export function normalize(path: string): string {
  const resolved = resolve(path).split(sep).join("/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

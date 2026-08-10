import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

/**
 * The npm package a file ships in, found the one way the design sanctions:
 * ascend to the **first** `package.json` and stop there. "Package" enters the
 * design only here, in the escape hatch's discovery walk-up — nothing merges
 * across a boundary, and a directory is answered once and cached.
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
  if (!existsSync(manifestPath)) {
    const parent = dirname(directory);
    return parent === directory ? undefined : homeOfDirectory(parent);
  }

  const packageJson = readJson(manifestPath);

  return {
    directory,
    name: typeof packageJson?.["name"] === "string" ? packageJson["name"] : undefined,
    entryPoints: entryPoints(directory, packageJson),
  };
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
  const add = (subpath: string, target: unknown): void => {
    const found = targetFiles(target).map((file) =>
      normalize(join(directory, file)),
    );
    if (found.length === 0) return;
    points.set(subpath, [...(points.get(subpath) ?? []), ...found]);
  };

  const exported = packageJson?.["exports"];
  if (typeof exported === "string" || Array.isArray(exported)) {
    add(".", exported);
  } else if (isRecord(exported)) {
    // `{ ".": … }` is a subpath map; anything else is the sugar form, one set
    // of conditions for the root.
    const subpaths = Object.keys(exported).filter((key) => key.startsWith("."));
    if (subpaths.length === Object.keys(exported).length) {
      for (const subpath of subpaths) add(subpath, exported[subpath]);
    } else {
      add(".", exported);
    }
  }

  if (points.size === 0) {
    for (const field of ["types", "typings", "main"]) {
      add(".", packageJson?.[field]);
    }
  }

  return points;
}

/** Every relative file an `exports` value can bottom out in. */
function targetFiles(target: unknown): readonly string[] {
  if (typeof target === "string") return target.startsWith(".") ? [target] : [];
  if (Array.isArray(target)) return target.flatMap(targetFiles);
  if (isRecord(target)) return Object.values(target).flatMap(targetFiles);
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

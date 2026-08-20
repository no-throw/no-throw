import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ColorTable, ColorTables } from "./document.js";
import { manifestAt, type ManifestState } from "./manifest.js";
import { join, normalize, packageHomeOf, type PackageHome } from "./packages.js";

const EMPTY: ColorTables = new Map();

const scans = new Map<string, ColorTables>();

/**
 * The overlays a project has installed, by the npm package each one colors.
 *
 * An overlay is matched by its manifest's `package` field and by nothing else.
 * The `@no-throw/foo__bar` spelling a scoped target gets is cosmetic convention
 * — npm has no nested scopes, so the name has to be mangled somehow — and a
 * resolver that parsed it would be deriving a fact it can simply read.
 *
 * "Installed" is Node's question rather than the walk-up's, so the scan climbs
 * the same `node_modules` chain a `require` would: a workspace package's
 * overlay is as often hoisted to the repository root as it is beside the
 * package itself. Nearest wins, for the same reason it wins there.
 *
 * The scan is version-blind in v1: an overlay published against a different
 * major of its target still answers, and the mismatch warning #17 reserved is
 * not built. Overlay majors track target majors by `@types` convention.
 */
export function overlaysFor(asking: PackageHome | undefined): ColorTables {
  if (asking === undefined) return EMPTY;

  const known = scans.get(asking.directory);
  if (known !== undefined) return known;

  const found = scan(asking.directory);
  scans.set(asking.directory, found);
  return found;
}

/** One installed overlay, as something to report on rather than to ask. */
export interface InstalledOverlay {
  readonly home: PackageHome;
  readonly state: ManifestState;
}

/**
 * Every `@no-throw/*` package a project has installed, with what its
 * `nothrow.json` came to — including the ones the scan passed over, which is
 * the half a resolver never has to name and a reader checking their setup
 * always does.
 */
export function installedOverlaysFor(
  asking: PackageHome | undefined,
): readonly InstalledOverlay[] {
  if (asking === undefined) return [];
  return installedOverlays(asking.directory).map((home) => ({
    home,
    state: manifestAt(home),
  }));
}

function scan(directory: string): ColorTables {
  const overlays = new Map<string, ColorTable>();

  for (const home of installedOverlays(directory)) {
    const state = manifestAt(home);
    // A `@no-throw/*` package with no usable manifest colors nothing: the three
    // shipped packages are the ordinary case, and one written against a wire
    // version this release cannot read has no field it may be trusted to name
    // a target in. Either way the rungs below it answer, which they are sound
    // by their own lights to do — an overlay supersedes no tag.
    if (state.kind !== "valid" || state.target === undefined) continue;
    if (!overlays.has(state.target)) overlays.set(state.target, state.table);
  }

  return overlays;
}

/** Every `@no-throw/*` package on the `node_modules` chain, nearest first. */
function installedOverlays(directory: string): readonly PackageHome[] {
  const found: PackageHome[] = [];

  for (let current = directory; ; current = dirname(current)) {
    const scope = join(current, "node_modules/@no-throw");
    for (const name of entriesIn(scope)) {
      const home = homeExactlyAt(join(scope, name));
      if (home !== undefined) found.push(home);
    }
    if (dirname(current) === current) return found;
  }
}

function entriesIn(directory: string): readonly string[] {
  try {
    // Sorted, so that two overlays installed side by side for one target are
    // resolved the same way on every machine rather than by directory order.
    return readdirSync(directory).sort();
  } catch {
    // No scope directory here, or one this process may not read. Either way
    // there is nothing installed at this rung to consult.
    return [];
  }
}

/**
 * The package rooted at exactly this directory. The walk-up answers with an
 * *ancestor's* package for anything that is not one — a stray file in the scope
 * directory would otherwise come back as the project itself.
 */
function homeExactlyAt(directory: string): PackageHome | undefined {
  const home = packageHomeOf(join(directory, "package.json"));
  return home?.directory === normalize(directory) ? home : undefined;
}

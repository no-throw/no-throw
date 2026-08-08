import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  readColorDocument,
  type ColorTable,
  type TablePath,
} from "./document.js";
import { isRecord, join, type PackageHome } from "./packages.js";
import { manifestSchema } from "./schemas.js";

/**
 * What a package's `nothrow.json` amounts to. The three failures are kept
 * apart because they resume differently: an absent or malformed manifest hands
 * the package back to its surviving tags, a stale one does the same but owes
 * the reader the file that drifted, and a manifest from a future version says
 * its facts need a reader this release does not have.
 */
export type ManifestState =
  | {
      readonly kind: "valid";
      readonly table: ColorTable;
      /**
       * The npm package these colors are about: an overlay's target, and a
       * shipped manifest's own name. It is the only thing an overlay is matched
       * by — never the npm name the overlay itself was published under.
       */
      readonly target: string | undefined;
    }
  | { readonly kind: "stale"; readonly file: string }
  | { readonly kind: "unreadable" }
  | { readonly kind: "absent" };

const ABSENT: ManifestState = { kind: "absent" };

/** One table, at `exports`. */
const TABLES: TablePath = ["exports"];

const states = new Map<string, ManifestState>();

/**
 * The manifest a package ships, verified. Hashes are checked here rather than
 * at load: only manifests actually consulted are verified, and a package is
 * answered once per process.
 *
 * An overlay's `nothrow.json` is read by this same function, because it is the
 * same file in the same shape — what makes it an overlay is that it names some
 * other package in `package`, and that a project installed it.
 */
export function manifestAt(home: PackageHome): ManifestState {
  const known = states.get(home.directory);
  if (known !== undefined) return known;

  const state = readManifest(home);
  states.set(home.directory, state);
  return state;
}

function readManifest(home: PackageHome): ManifestState {
  const path = join(home.directory, "nothrow.json");
  if (!existsSync(path)) return ABSENT;

  const document = readColorDocument(path, manifestSchema(), [], TABLES);
  if (document.kind !== "read") {
    return document.kind === "unreadable" ? { kind: "unreadable" } : ABSENT;
  }

  const stale = staleFile(home, document.value["files"]);
  if (stale !== undefined) return { kind: "stale", file: stale };

  const target = document.value["package"];
  return {
    kind: "valid",
    table: document.tableAt([]),
    target: typeof target === "string" ? target : undefined,
  };
}

/**
 * The first file whose hash no longer matches what the manifest was written
 * for. Drift lives in `.js` bodies, invisible at declaration granularity,
 * which is why the hashes are over files rather than over entries — and why a
 * file that has since been deleted counts as drift like any other.
 */
function staleFile(
  home: PackageHome,
  files: unknown,
): string | undefined {
  if (!isRecord(files)) return undefined;

  for (const [relativePath, expected] of Object.entries(files)) {
    const path = join(home.directory, relativePath);
    if (!existsSync(path) || integrityOf(path) !== expected) {
      return relativePath;
    }
  }
  return undefined;
}

/**
 * A file's SRI hash, in the one spelling both sides of the wire use. Shared
 * with the emitter rather than restated there: a producer that hashed
 * differently from the reader would floor every manifest it published.
 */
export function integrityOf(path: string): string {
  return `sha256-${createHash("sha256").update(readFileSync(path)).digest("base64")}`;
}

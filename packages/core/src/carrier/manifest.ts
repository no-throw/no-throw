import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { AccessorFact, Color, ConditionPath } from "../baseline/types.js";
import { join, readJson, type PackageHome } from "./packages.js";
import { validate, type SchemaIssue } from "./schema.js";

/**
 * One symbol's colors on the wire. The same four facts the baseline carries,
 * with the same fail-safe reading of absence, so every rung of the resolver
 * chain composes the same way.
 */
export interface ManifestEntry {
  readonly color?: Color;
  readonly async?: boolean;
  readonly conditions?: readonly ConditionPath[];
  readonly accessor?: AccessorFact;
}

/**
 * An entry, or the fact that one was written and cannot be used. The second is
 * not the same as no entry at all: a key the manifest claims and this reader
 * cannot honor floors rather than falling through to a rung that knows less
 * about it.
 */
export type EntryState =
  | { readonly kind: "entry"; readonly entry: ManifestEntry }
  | { readonly kind: "unusable" };

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
      readonly entryFor: (subpath: string, key: string) => EntryState | undefined;
    }
  | { readonly kind: "stale"; readonly file: string }
  | { readonly kind: "unreadable" }
  | { readonly kind: "absent" };

const ABSENT: ManifestState = { kind: "absent" };

/** The wire version this release understands. */
const VERSION = 1;

const SCHEMA_FILE = new URL(
  "../../schema/nothrow.schema.json",
  import.meta.url,
);

let schema: unknown;

/**
 * The published schema, which is also the one the reader enforces. Shipping
 * one file for both is what keeps the contract hand-authors validate against
 * from drifting away from the contract the engine actually applies.
 */
export function manifestSchema(): unknown {
  schema ??= JSON.parse(readFileSync(SCHEMA_FILE, "utf8")) as unknown;
  return schema;
}

const states = new Map<string, ManifestState>();

/**
 * The manifest a package ships, verified. Hashes are checked here rather than
 * at load: only manifests actually consulted are verified, and a package is
 * answered once per process.
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

  const document = readJson(path);
  if (document === undefined) return ABSENT;

  const issues = validate(manifestSchema(), document);
  // An issue inside one entry floors that entry; anything shallower is a
  // manifest that does not describe a manifest, and nothing is taken from it.
  if (issues.some((issue) => !isEntryIssue(issue))) return ABSENT;

  if (document["version"] !== VERSION) return { kind: "unreadable" };

  const stale = staleFile(home, document["files"]);
  if (stale !== undefined) return { kind: "stale", file: stale };

  const exported = document["exports"] as Record<string, unknown>;
  const unusable = new Set(issues.map((issue) => entryOf(issue.path)));

  return {
    kind: "valid",
    entryFor: (subpath, key) => {
      if (unusable.has(entryOf(["exports", subpath, key]))) {
        return { kind: "unusable" };
      }
      const entries = exported[subpath];
      const entry = isRecord(entries) ? entries[key] : undefined;
      return isRecord(entry)
        ? { kind: "entry", entry: entry as ManifestEntry }
        : undefined;
    },
  };
}

/** `exports` → subpath → key → the fault: three segments deep, and no more. */
function isEntryIssue(issue: SchemaIssue): boolean {
  return issue.path.length > 3 && issue.path[0] === "exports";
}

/**
 * Which entry a path lands in, as an identity. Encoded rather than joined: a
 * subpath follows npm's grammar and a key follows JSDoc's, and any separator
 * either of them could hold would merge two entries and floor the wrong one.
 */
function entryOf(path: readonly string[]): string {
  return JSON.stringify(path.slice(0, 3));
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

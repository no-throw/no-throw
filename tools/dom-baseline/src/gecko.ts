import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONSTRUCT_SEGMENT,
  memberKey,
  staticMemberKey,
} from "@no-throw/core/baseline";

/**
 * Gecko's `.webidl` annotates operations and attributes it can throw from with
 * `[Throws]`. It is a **one-way** oracle, and the direction is doctrine rather
 * than measurement (#26, #30 §F):
 *
 * > *Presence* is a sound throwing signal. *Absence* is one implementation's
 * > behavior, not the contract, and reading absence as clean is the unsafe
 * > direction — precisely #22's ECMA-402 mistake.
 *
 * So this module only ever produces keys that are **throwing**. There is no
 * function here that answers "is it clean", because that answer would be
 * unsound and its absence is what keeps it from being written by accident.
 */

const REPO = "mozilla/gecko-dev";
const BRANCH = "master";
const LISTING = `https://api.github.com/repos/${REPO}/contents/dom/webidl?ref=${BRANCH}`;

const CACHE_DIR = new URL("../.cache/gecko/", import.meta.url);

export function geckoCacheDir(): string {
  return fileURLToPath(CACHE_DIR);
}

interface Listing {
  readonly name: string;
  readonly download_url: string | null;
}

export interface GeckoFetchReport {
  readonly files: number;
  readonly bytes: number;
  readonly failures: number;
}

const CONCURRENCY = 8;

export async function fetchGeckoIdl(): Promise<GeckoFetchReport> {
  const response = await fetch(LISTING, {
    headers: { accept: "application/vnd.github+json", "user-agent": "no-throw-dom-baseline/0.1" },
  });
  if (!response.ok) throw new Error(`${LISTING} responded ${response.status}`);
  const listing = (await response.json()) as readonly Listing[];
  const targets = listing.filter((entry) => entry.name.endsWith(".webidl"));

  const dir = geckoCacheDir();
  mkdirSync(dir, { recursive: true });

  let files = 0;
  let bytes = 0;
  let failures = 0;
  const queue = [...targets];

  const worker = async (): Promise<void> => {
    for (let target = queue.shift(); target !== undefined; target = queue.shift()) {
      const path = join(dir, target.name);
      try {
        bytes += readFileSync(path, "utf8").length;
        files++;
        continue;
      } catch {
        /* not cached yet */
      }
      const url = target.download_url;
      if (url === null) continue;
      try {
        const idl = await fetch(url, {
          headers: { "user-agent": "no-throw-dom-baseline/0.1" },
        });
        if (!idl.ok) throw new Error(`HTTP ${idl.status}`);
        const text = await idl.text();
        writeFileSync(path, text);
        bytes += text.length;
        files++;
      } catch {
        failures++;
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { files, bytes, failures };
}

const INTERFACE = /\b(?:partial\s+)?(?:interface|namespace)\s+(?:mixin\s+)?([A-Za-z_]\w*)/;
const THROWS = /\[[^\]]*\bThrows\b/;
/** `Element? closest(UTF8String selector);` — the name before the argument list. */
const OPERATION = /([A-Za-z_]\w*)\s*\(/;
/** `readonly attribute DOMString innerHTML;` — the name before the semicolon. */
const ATTRIBUTE = /\battribute\b[^;]*?([A-Za-z_]\w*)\s*;/;

/**
 * Baseline keys Gecko marks `[Throws]`. Nothing else — a member absent from the
 * result is not thereby clean, it is simply unremarked.
 */
export function geckoThrowingKeys(): ReadonlySet<string> {
  const dir = geckoCacheDir();
  let files: readonly string[];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith(".webidl")).sort();
  } catch {
    return new Set();
  }

  const keys = new Set<string>();
  for (const file of files) {
    const lines = readFileSync(join(dir, file), "utf8").split("\n");
    let owner: string | undefined;

    for (const [index, raw] of lines.entries()) {
      const line = raw.trim();
      const declared = INTERFACE.exec(line)?.[1];
      if (declared !== undefined) {
        owner = declared;
        continue;
      }
      if (line === "};") owner = undefined;
      if (owner === undefined || !THROWS.test(line)) continue;

      // The annotation sits on its own line above the member far more often
      // than inline, so the declaration is whatever remains here, else the next
      // line that is neither blank nor a comment.
      let declaration = line.replace(/^\[[^\]]*\]\s*/, "");
      for (let ahead = index + 1; declaration === "" && ahead < lines.length; ahead++) {
        const candidate = lines[ahead]?.trim() ?? "";
        if (candidate === "" || candidate.startsWith("//") || candidate.startsWith("*")) {
          continue;
        }
        declaration = candidate;
      }
      if (declaration === "") continue;

      const member = /\battribute\b/.test(declaration)
        ? ATTRIBUTE.exec(declaration)?.[1]
        : OPERATION.exec(declaration)?.[1];
      if (member === undefined) continue;

      keys.add(
        member === "constructor"
          ? staticMemberKey(owner, CONSTRUCT_SEGMENT)
          : /\bstatic\b/.test(declaration)
            ? staticMemberKey(owner, member)
            : memberKey(owner, member),
      );
    }
  }
  return keys;
}

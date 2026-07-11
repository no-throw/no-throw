// manifest-reader.mjs — THROWAWAY spike (no-throw ticket #15).
//
// The fs-touching half of the manifest transport: given a declaration from some
// .d.ts, walk up to the owning package's package.json, follow its "nothrow"
// discovery field to the manifest, and answer what the manifest asserts about
// that symbol. Injected into the engine as opts.resolveOpaque — the engine
// itself stays fs-free (same seam inference sits behind, #4).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const dirCache = new Map(); // dir → parsed manifest | null

function manifestForDir(dir) {
  if (dirCache.has(dir)) return dirCache.get(dir);
  let result = null;
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    // package boundary reached: the manifest is here or nowhere
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (typeof pkg.nothrow === 'string') {
        result = JSON.parse(readFileSync(join(dir, pkg.nothrow), 'utf8'));
      }
    } catch {
      result = null; // unreadable ⇒ fail safe to the floor
    }
  } else {
    const parent = dirname(dir);
    result = parent === dir ? null : manifestForDir(parent);
  }
  dirCache.set(dir, result);
  return result;
}

/**
 * (decl) => { color, async } | undefined
 * SPIKE keying: bare top-level export name. The real schema needs export
 * subpath + symbol paths (Type#method, overload indices) — see NOTES.md.
 */
export function makeManifestResolver() {
  return (decl) => {
    const fileName = decl.getSourceFile?.()?.fileName;
    const name = decl.name?.getText?.();
    if (!fileName || !name) return undefined;
    const manifest = manifestForDir(dirname(fileName));
    return manifest?.exports?.[name];
  };
}

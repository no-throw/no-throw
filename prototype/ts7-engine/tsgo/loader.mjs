/**
 * Resolve `typescript` to the TypeScript 7 shim, for everything under
 * `@nothrow/core`. The driver itself still gets the real TypeScript, so the two
 * engines can be compared in one process.
 *
 * Register with `node --import ./tsgo/register.mjs`.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const shim = pathToFileURL(
  path.join(import.meta.dirname, "typescript-shim.mjs"),
).href;

/**
 * `@nothrow/core` is installed as a file: dependency, so it resolves through to
 * `packages/core` — the substitution has to key on that path, not on the
 * package name it was imported under.
 */
const ENGINE = /[/\\](packages[/\\]core|@nothrow[/\\]core)[/\\]/u;

export function resolve(specifier, context, next) {
  if (specifier === "typescript" && ENGINE.test(context.parentURL ?? "")) {
    return { url: shim, shortCircuit: true, format: "module" };
  }
  return next(specifier, context);
}

# Releasing

Three packages, one version, one dispatch.

`@no-throw/core`, `@no-throw/eslint-plugin` and `@no-throw/cli` are versioned in
lockstep. That is not a convention here: `scripts/check-lockstep.mjs` fails the
build on a mismatch, pins the internal dependencies to `workspace:*` so a
release cannot ship a package against a stale sibling, and refuses two packages
that name the same peer differently.

## Cutting a release

Run the **Release** workflow from the Actions tab with the version, e.g.
`1.0.0`. There is no second step, and nothing is cut from a working tree.

The workflow, in order:

1. Checks out `main`.
2. `node scripts/release.mjs <version>` — writes the version to the root
   manifest and all three packages, and refuses to start if they were already
   out of lockstep.
3. Builds, then runs **every** gate: the conformance suite, its declare-only
   superset run, the CLI suite, the §H diagnostics audit, both peer gates, and
   the ES and DOM fuzz, drift and deferred-invocation gates.
4. `node scripts/check-packed.mjs` — packs all three and reads the tarballs, so
   a `files` list that forgot `baseline-data` is caught before publish rather
   than by the first consumer, whose symptom would be every builtin flooring.
5. Commits, tags `v<version>`, pushes both.
6. Publishes core first, then the two adapters — they name core as a
   dependency, and pnpm rewrites `workspace:*` to the exact version as it
   packs, so an adapter on the registry ahead of core is unresolvable.
7. Creates the GitHub release from `docs/release-notes/v<version>.md`.

The gates run **after** the bump, so what they prove is the tree that ships.

`dry-run: true` runs everything through step 4 and stops. Use it to price a
release without pushing anything.

### Before the first one

Three things live outside the repo and are the owner's:

- **`NPM_TOKEN`** — an automation token for the `no-throw` npm org, as a secret
  on the `release` environment. Publishing uses npm provenance, so the token
  needs publish rights and nothing else.
- **The `release` environment** — worth a required reviewer, since the publish
  is the one step in this repo nothing can undo.
- **GitHub Pages** — set the source to *GitHub Actions*. The **Schema**
  workflow deploys there; see below.

Write the release notes at `docs/release-notes/v<version>.md` first. The
workflow reads that path and fails without it, which is deliberate: a release
with no notes is a version number.

The README's **Status** section still opens with *nothing is published to npm
yet*. It stops being true the moment the first release lands, so rewriting it is
part of cutting that release rather than a follow-up.

## The schemas

`nothrow.json` and `nothrow.overrides.json` are a sanctioned hand-written path,
so they get the editor validation any other JSON format gets. That needs the
schema *served*, not just committed.

**Canonical URLs** — a [spec call], recorded here:

```
https://no-throw.github.io/no-throw/schema/v1/nothrow.schema.json
https://no-throw.github.io/no-throw/schema/v1/nothrow.overrides.schema.json
```

The version in the path is the **manifest wire format's**, not the packages'.
A manifest states `"version": 1`, and an unknown version floors the whole file
— so a v2 schema served where v1 used to be would tell an editor that a
perfectly good v1 manifest is wrong. The packages move on their own schedule
and never appear in these URLs.

`…/schema/` without the version serves the current major, which is what the
README hands a reader writing one of these files by hand. Both copies carry the
**versioned** `$id`: one document, one identity, whichever path fetched it.
`scripts/check-schema-urls.mjs` runs in the deploy and fails if an `$id` or an
absolute `$ref` does not match where the file is actually served.

The **Schema** workflow publishes on every push to `main` that touches
`packages/core/schema/`, so the served copy cannot lag the shipped one.

## SchemaStore

One submission covers both files. It is a pull request against
[SchemaStore/schemastore](https://github.com/SchemaStore/schemastore), adding
these two objects to the **top** of the `schemas` array in
`src/api/json/catalog.json` — the catalog is broadly alphabetical, but new
entries go in at the head:

```json
{
  "name": "no-throw manifest",
  "description": "nothrow.json — the colors a package publishes for its own exported surface, read by the no-throw checker",
  "fileMatch": ["nothrow.json"],
  "url": "https://no-throw.github.io/no-throw/schema/v1/nothrow.schema.json"
},
{
  "name": "no-throw overrides",
  "description": "nothrow.overrides.json — project-local colors for packages you did not write, outranking every other no-throw carrier",
  "fileMatch": ["nothrow.overrides.json"],
  "url": "https://no-throw.github.io/no-throw/schema/v1/nothrow.overrides.schema.json"
}
```

Both filenames are matched because both are hand-written. `nothrow.json` is
usually emitted, but an overlay author writes one by hand — that is the whole
reason the format has a published schema.

The schemas must be **live at those URLs before the PR is opened**;
SchemaStore's CI fetches every catalog URL. So the order is: land the schema
workflow, confirm both URLs resolve, then submit.

Opening the PR is an account action and stays with the owner.

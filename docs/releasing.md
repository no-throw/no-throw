# Releasing

Three packages, one version, and nobody types it.

`@no-throw/core`, `@no-throw/eslint-plugin` and `@no-throw/cli` are versioned in
lockstep. That is not a convention here: `scripts/check-lockstep.mjs` fails the
build on a mismatch, pins the internal dependencies to `workspace:*` so a
release cannot ship a package against a stale sibling, and refuses two packages
that name the same peer differently.

Releases are cut by
[release-please](https://github.com/googleapis/release-please), configured in
`release-please-config.json` with the last released version in
`.release-please-manifest.json`. The three packages are not three release units:
the repository root is the single unit, and the config's `extra-files` writes
its version into all three manifests. One tag, one changelog, and lockstep by
construction rather than by something keeping three numbers in agreement.

## The commit convention

The version is a reading of what merged, so what merged has to be readable.
Subjects carry a [Conventional Commits](https://www.conventionalcommits.org)
type, and the sentence after it is the same sentence it always was:

```
feat: reach the packages an override key could not name
fix: let a condition say "you passed nothing"
fix!: move the packages to the @no-throw scope
chore: bump the eslint peer range
```

`feat` takes the minor, `fix` and `perf` the patch, and a `!` before the colon —
or a `BREAKING CHANGE:` footer — takes the major. Everything else (`chore`,
`docs`, `ci`, `refactor`, `test`) lands without moving anything, and does not
appear in the changelog.

Merges here are squashes, so the subject that reaches `main` is the **pull
request title**. That is the one that has to carry the type; the commits on the
branch are yours. Nothing enforces this — a mistyped prefix costs a release
note, not a broken release, and the alternative is a hook that stands between
you and every commit.

Pick the type for what the change does to a consumer, not for how much of it
there was. A rewritten internal walk that a consumer cannot observe is a
`chore`; a widened peer range they can install against is a `feat`.

## Cutting a release

There is nothing to run. Landing a `feat` or a `fix` on `main` opens — or
updates — a pull request titled **chore(main): release x.y.z**, which bumps the
four manifests and writes the section of `CHANGELOG.md` for that version.
Reviewing that PR is the release review: the diff is the version and the notes,
and CI runs the full battery on it.

Merging it is the release. On the push that follows, the workflow:

1. Tags `v<version>` and creates the GitHub release from the changelog section.
2. Runs the publish job, gated on the `release` environment: build, then
   **every** gate — the conformance suite, its declare-only superset run, the
   CLI suite, the §H diagnostics audit, both peer gates, and the ES and DOM
   fuzz, drift and deferred-invocation gates.
3. `pnpm run check:packed` — packs all three and reads the tarballs, so a
   `files` list that forgot `baseline-data` is caught before publish rather than
   by the first consumer, whose symptom would be every builtin flooring.
4. Publishes core first, then the two adapters — they name core as a dependency,
   and pnpm rewrites `workspace:*` to the exact version as it packs, so an
   adapter on the registry ahead of core is unresolvable.

The gates run on the release commit, so what they prove is the tree that ships.
They run there **again**, rather than being trusted from the release PR, because
a PR opened with the default `GITHUB_TOKEN` triggers no other workflow: without
`RELEASE_PLEASE_TOKEN` below, the release PR gets no CI at all.

The tag and the GitHub release are cut before the gates run, which is the one
ordering this pipeline cannot fix — the release is what tells the workflow a
release happened. A gate failing there leaves a tag and an empty release with
nothing published, which is recoverable; the registry is not, and nothing
reaches it until every gate is green.

Re-running the **Release** workflow by hand runs the publish job on its own.
That is for a publish that failed with the tag already cut; it is not how a
release is normally made.

### Naming a version by hand

`Release-As: <version>` as a footer on a commit landing on `main` overrides what
the log would have computed, and opens a release PR even where nothing
releasable landed. It is how a version gets chosen rather than inferred — the
first release used it, and so would a jump to `1.0.0`.

`docs/release-notes/` holds hand-written launch prose. Nothing reads it: it is
there to paste above the generated section of a GitHub release body, for the
releases that deserve more than a list of commit subjects.

### What the pipeline depends on

Four things live outside the repo. They are set up; this is what to check when
one expires or a release fails at a step that used to work.

- **`NPM_TOKEN`** — a granular npm token scoped to `@no-throw`, read and write,
  as a secret on the **`release` environment** rather than on the repository. An
  environment secret is readable only by a job running in that environment,
  which is what makes the reviewer gate mean something: a repository secret
  would be readable by any workflow.
- **The `release` environment** — a required reviewer, since the publish is the
  one step in this repo nothing can undo, and a branch policy admitting only
  `main`.
- **`RELEASE_PLEASE_TOKEN`** — a PAT or App token with `contents` and
  `pull-requests` write, as a repository secret. Optional, and the workflow
  falls back to `GITHUB_TOKEN`; what it buys is CI running on the release PR,
  because a PR opened with the default token triggers no other workflow. When it
  expires the release PR stops being opened at all, which is a louder failure
  than one arriving unproven.
- **GitHub Pages** — source set to *GitHub Actions*. The **Schema** workflow
  deploys there; see below.

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

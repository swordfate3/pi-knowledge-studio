# Project storage layout and upgrade

All default persistent Studio data is project-relative, not home-global:

```text
<cwd>/.pi/knowledge-studio/
  collections/<collection>/   # V2 SQLite catalog, blobs, vectors, hints
  pdf-jobs/                   # durable whole-PDF spools and checkpoints
  pdf-generations/            # registry.sqlite, captures, index generations
  exports/<output>/<package>/ # generated and deterministic portable documents
  legacy-v1/collections/      # incompatible V1 JSON manifests and copied assets
```

PDF model profiles and their selected default remain in `pdf-generations/registry.sqlite`, with immutable revisions and credential **environment references**, not API keys. Moving this directory intact preserves profile/index identity. V1 extraction profiles are shipped source/config, not a mutable model registry. Host environment configuration and Pi's own settings remain host-managed, not copied into Studio. Standalone runtime constructors and explicit export paths are unchanged. The V1 `PI_KNOWLEDGE_STUDIO_HOME` override and explicit `resolveDataRoot(cwd, "global")` retain their previous meaning; neither changes V2 defaults. No default switches to a shared home store.

The extension uses the shared resolver in `src/core/studio-paths.ts`. V2's mutation queue is keyed by the umbrella root. Existing permission, no-follow and containment checks still apply to child stores; new exports are hidden from source ingestion along with the entire `.pi` tree. The old external export directory remains excluded from V2 inputs too.

## Existing projects: explicit offline migration only

No automatic move, deletion, merge, schema conversion, embedding, or reindex is performed. Default storage access fails with an actionable error if any old sibling root remains, **even if a new destination already exists**. V1 JSON markers under the old umbrella `collections/` are also detected; they must not be interpreted as V2 catalogs. Inspection is read-only; symlink roots fail closed. Merely loading the extension does not inspect or create storage.

1. Stop **all** Pi sessions, standalone workers, PDF jobs and writers for this project. A paused job alone is not proof that an HTTP call or SQLite writer has exited. Do not relocate live databases or SQLite sidecars.
2. Make and verify an offline backup of all old roots, including database sidecars, blobs, spools and profiles. Keep the backup outside the recognized project roots. Preserve ownership and private permissions (directories 0700; private store files 0600). Do not recursively chmod the workspace.
3. Inventory the source and destination paths below. Reject symlinks. If a destination exists, **stop**: do not use a merging `mv`/copy or overwrite. Resolve competing stores offline, retaining both backups. For V1, migrate its JSON collections **before** bringing in V2 collections.

| Old source | New destination |
| --- | --- |
| `.pi/knowledge-studio/collections` containing V1 `collection.json` / `manifest.json` | `.pi/knowledge-studio/legacy-v1/collections` |
| `.pi/knowledge-studio-v2` | `.pi/knowledge-studio/collections` |
| `.pi/knowledge-studio-v2-pdf-jobs` | `.pi/knowledge-studio/pdf-jobs` |
| `.pi/knowledge-studio-v2-pdf-generations` | `.pi/knowledge-studio/pdf-generations` |
| `knowledge-studio-v2-exports` | `.pi/knowledge-studio/exports` |

4. With writers stopped and destinations absent, create the private umbrella/`legacy-v1` parent as needed and relocate each **whole directory** to its exact destination using your filesystem's no-clobber operation. Do not move the old V1 umbrella into its own descendant. V1 stored asset paths are relative to its data root: moving `collections/` intact under `legacy-v1/` preserves them. Do not split the PDF registry from its relative capture directories. Do not edit IDs, hashes, vectors or database schemas.
5. Keep verified backups outside the recognized old paths: leaving even an empty old sibling directory intentionally continues to block defaults. Retire those old path names only as an explicit operator action after verification. Empty old V1 `collections/` has no JSON marker/data to migrate; an existing empty destination still requires operator inspection before relocation.
6. Restart, list collections/profiles, inspect PDF status and perform local lexical searches. Verify exported packages offline, including original images. Existing absolute export references in old conversation results will not be rewritten; use the new package path. Historical provenance source paths are not rewritten either. Migration does not authorize network calls or reindexing.

Unrecognized/custom V1 data roots are not scanned or migrated; explicit-path callers remain responsible for their chosen locations. Historical reports and temporary evaluation artifact paths describe past runs and are not rewritten by this change.

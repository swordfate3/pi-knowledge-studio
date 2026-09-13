# Studio storage layout and upgrade

Knowledge Studio stores persistent data in the user's private Pi directory, not in the project checkout:

```text
~/.pi/knowledge-studio/
  collections/<collection>/   # SQLite catalog, blobs, vectors, hints
  pdf-jobs/                   # durable whole-PDF spools and checkpoints
  pdf-generations/            # profile registry, captures, immutable generations
  exports/<output>/<package>/ # generated or deterministic portable documents
```

Set the compatibility-stable `PI_KS_V2_DATA_DIR` to an **absolute** private directory before starting Pi to override this root. The value is captured when the extension registers. PDF model profile records contain credential environment-variable references, not API keys.

## Removed V1 JSON stores

The V1 runtime and its JSON store implementation are no longer shipped. Current Knowledge Studio checks both the selected `collections/` directory and the former project-local `<cwd>/.pi/knowledge-studio/legacy-v1/collections` root. If that old root exists, or if `collection.json` or `manifest.json` markers from V1 are found under the selected `collections/` directory, startup fails closed and does not move, merge, overwrite, or reinterpret them.

To preserve old data:

1. Stop every old and current Studio process and make a verified offline backup.
2. Use the old release in an isolated checkout to export any material you still need.
3. Verify the export independently.
4. Archive or remove the old JSON directory yourself before starting the current release.

There is intentionally no in-place V1-to-current converter in this package.

## Earlier current-runtime roots

Earlier development builds stored current-format data in project-local sibling directories. These are detected read-only and block startup until an operator relocates them:

| Old source | Current destination |
| --- | --- |
| `<cwd>/.pi/knowledge-studio-v2` | `~/.pi/knowledge-studio/collections` |
| `<cwd>/.pi/knowledge-studio-v2-pdf-jobs` | `~/.pi/knowledge-studio/pdf-jobs` |
| `<cwd>/.pi/knowledge-studio-v2-pdf-generations` | `~/.pi/knowledge-studio/pdf-generations` |
| `<cwd>/knowledge-studio-v2-exports` | `~/.pi/knowledge-studio/exports` |

Migration is explicit and offline only:

1. Stop all Pi sessions, workers, PDF jobs, and writers. A paused job alone does not prove every HTTP or SQLite writer exited.
2. Back up complete directories, including SQLite sidecars, blobs, spools, and profile registries. Preserve private ownership and permissions.
3. Reject symlinks. If a destination exists, stop instead of merging or overwriting it.
4. Move each whole directory with a no-clobber filesystem operation. Do not edit IDs, hashes, vectors, schemas, or relative capture paths.
5. Remove empty old path names only after verification; their presence intentionally keeps startup blocked.
6. Restart, list data, inspect PDF status, run local lexical searches, and verify portable packages offline.

No migration authorizes network calls, embedding, reindexing, or source-path rewriting. Historical absolute export/source paths remain historical.

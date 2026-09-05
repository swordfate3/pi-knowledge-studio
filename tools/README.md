# Tools and validation

This directory is for repository maintenance helpers, not runtime product behavior. Keep tools deterministic, documented, and safe to run against synthetic fixtures.

From the repository root, the supported validation commands are:

```sh
npm install
npm run check
npm test
```

The package requires Node.js `>=22.19.0`. `check` runs TypeScript without emitting files; `test` runs the available TypeScript tests. Neither command supplies embeddings, BM25, complete PDF OCR, a document generator, or a live vision service.

Maintenance tooling must not read or bundle credentials, private books, broad home-directory data, generated collections, or downloaded model files. Do not encode machine-specific absolute paths in scripts or documentation. Review `git diff` and package contents before publishing.

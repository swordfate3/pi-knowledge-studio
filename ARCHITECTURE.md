# Architecture

## Product boundary

Pi Knowledge Studio is one generic multimodal knowledge extension for Pi. The public Pi transport is `extensions/index.ts`; application behavior lives under `src/`. Compatibility-stable names such as `ks_v2_*`, `PI_KS_V2_*`, and persisted schema/recipe version strings are protocol identities, not separate product implementations.

The implementation is local-first and provenance-aware. It provides bounded document capture, content-addressed blobs, SQLite catalogs, lexical/hybrid retrieval, optional model adapters, grounded generation, portable exports, and durable native-PDF jobs. It does not claim unrestricted document rendering, semantic proof, complete OCR/layout recovery, or production multi-tenant isolation.

## Dependency direction

```text
extensions/index.ts                 Pi tools, confirmations, host configuration
        |
        v
src/application/                    use cases and orchestration
        |
        +--> src/domain/            evidence, answer, OCR, rendition contracts
        +--> src/ports/             adapter interfaces
        |
        v
src/adapters/                       SQLite/blob/model/parser/export implementations

src/core/                           shared path and retrieval primitives
```

- `src/domain/` contains durable contracts and must not depend on Pi transport or concrete providers.
- `src/ports/` defines adapter boundaries.
- `src/application/` coordinates capture, retrieval, validation, generation, enrichment, PDF jobs, and recovery.
- `src/adapters/` owns local storage, parsers, export rendering, and optional HTTP model protocols.
- `src/core/` contains reusable path-safety, storage-root, and retrieval-chunk helpers.
- `extensions/index.ts` is the only package entry and owns user-visible tools, approvals, and environment snapshots.

## Main data flow

```text
approved local source
  -> confined parser/capture adapter
  -> validated immutable text/image provenance
  -> SQLite catalog + content-addressed blobs
  -> lexical or explicitly configured hybrid retrieval
  -> validated evidence bundle
  -> deterministic export OR approved grounded model generation
  -> portable Markdown/HTML + selected source assets + manifests
```

Vision-derived descriptions remain retrieval-only hints. OCR transcripts remain explicitly unverified. Neither replaces original source evidence.

## Storage and compatibility

The default private root is `~/.pi/knowledge-studio/`, resolved by `src/core/studio-paths.ts`, with `collections/`, `pdf-jobs/`, `pdf-generations/`, and `exports/`. `PI_KS_V2_DATA_DIR` is retained as a deployment-compatible absolute override.

The removed V1 JSON implementation is not linked into the package. Current code only detects its incompatible markers and fails closed to prevent accidental overwrite. Old sibling roots are likewise detected without automatic move, merge, embedding, or reindexing. See [`docs/storage-layout.md`](docs/storage-layout.md).

Persisted identifiers such as `grounded-answer-v2`, `native-pdf-job-v1`, catalog schema versions, parser recipes, and model-space revisions are data/wire contracts. Changing them requires an explicit migration and is independent of product naming.

## Security and consent

- Source paths are confined beneath the Pi working directory and checked against symlink/path policy.
- Runtime storage is private and outside the checkout by default.
- Network embedding, reranking, generation, vision, and content disclosure require the applicable trusted approval or host grant.
- Registration performs no filesystem writes or network requests.
- Gates are consent boundaries, not an OS sandbox; same-user processes and other extensions may still access data.
- Cancellation is cooperative and cannot necessarily interrupt an in-flight HTTP request or already committed local mutation.

## Verification

```sh
npm run check
npm test
npm pack --dry-run
```

These checks verify the tested contracts and package contents; they do not establish semantic correctness, production scalability, or a latency SLA.

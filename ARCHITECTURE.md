# Architecture

> The sections below describe the implemented **0.1.0 MVP** used by the current Pi tools. A separate experimental [portable-image export slice](docs/portable-export-slice.md) is now implemented, but is not wired into these tools. The broader architecture remains proposed: see [redesign proposal](docs/multimodal-redesign.md), [validation plan](docs/redesign-validation.md), and [visual overview](docs/multimodal-redesign.html).

## Product boundary

Pi Knowledge Studio is a **generic, profile-driven Pi package**. It provides reusable ingestion, provenance, lexical retrieval, asset storage, optional vision, and Markdown rendering. A profile supplies domain terminology and interpretation guidance; it does not introduce domain-specific storage or algorithms. The built-in FreeRTOS / STM32 profile is an optional demonstration of this mechanism only.

The current MVP is deliberately local and file-backed. It is not an embedding/BM25/RAG platform, complete OCR service, or document generator.

## Data flow

```text
local source path
  -> source reader (supported text/PDF formats)
  -> normalization and character chunking
  -> document/chunk records + SHA-256 provenance
  -> local collection JSON and copied referenced assets
  -> simple lexical search (chunks, optionally asset metadata)
  -> evidence-first Markdown draft with source locators
  -> optional vision request for selected image bytes
```

The exported API is assembled by `src/index.ts`. Responsibilities are separated into:

- `src/config.ts`: environment parsing and project/global data-root resolution.
- `src/ingest/source-reader.ts`: supported file discovery, text extraction, and safe-size asset copying.
- `src/core/`: records, chunking, lexical scoring, stable IDs, hashes, and citation labels.
- `src/storage/store.ts`: collection schema, JSON persistence, atomic writes, and manifest counts.
- `src/retrieval/search.ts`: bounded lexical search and optional asset search.
- `src/generation/markdown.ts`: evidence-first Markdown output; it does not invent evidence.
- `src/profiles/profile.ts`: generic and optional example profiles.
- `src/vision/provider.ts`: opt-in OpenAI-compatible image explanation adapter.

## Storage and boundaries

The data root defaults to `.pi/knowledge-studio` for project scope or the user's Pi data area for global scope; `PI_KNOWLEDGE_STUDIO_HOME` overrides it. Collections are keyed under `collections/<safe-name>/`, with `collection.json` and an `assets/` directory. Writes use a temporary file followed by rename. Source URIs and stored asset paths remain part of provenance, so output must be reviewed before sharing.

The source boundary is local filesystem input. Supported discovery includes Markdown, text, RST, HTML, JSON, CSV, and PDF paths; Markdown and HTML can reference local images that are copied. Network image URLs are not fetched. PDF extraction is optional and text-focused; absent support produces a warning rather than complete OCR. Vision is the only outbound content path and is explicitly configured by the caller.

## Dependency direction

Profiles and core records are stable domain concepts. Ingestion, storage, retrieval, rendering, and vision are adapters/use cases around those concepts. Core code must stay independent of Pi transport details, vendor SDKs, databases, and board-specific assumptions. New integrations should be optional adapters, not hidden requirements of the generic core.

## Runtime and verification

The package requires Node.js `>=22.19.0`, uses native ESM and TypeScript, and has no generated vendor workflow. Run:

```sh
npm run check
npm test
```

These validate TypeScript and execute available tests; they do not establish OCR, model, or publication-quality behavior.

## Security posture

Do not ingest credentials, private books, secrets, or broad home-directory trees. Keep `.env` and generated collection data out of commits, use least-privilege source/output directories, and understand that enabling vision sends selected image data to the configured endpoint. See [config/README.md](config/README.md) and [README.md](README.md) for operational details.

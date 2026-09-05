# Pi Knowledge Studio

A **generic, profile-driven Pi package** for building small, provenance-aware knowledge workspaces. The package is intentionally domain-neutral: profiles provide terminology and explanation guidance without changing the core data model. **FreeRTOS / STM32 is an optional built-in example profile, not the product scope or a required platform.**

> MVP status: the implementation is a useful local ingestion and evidence workspace, not a full RAG or document-production system.

## What the MVP does

- Ingests text-oriented files: Markdown, plain text, RST, HTML, JSON, CSV, and text that can be extracted from a PDF when the optional PDF extractor is available.
- Normalizes and chunks text, then performs simple in-memory lexical substring scoring.
- Preserves source locators and SHA-256 provenance for documents and assets.
- Copies local Markdown/HTML image assets into the collection's `assets/` directory, subject to a configurable size limit.
- Renders evidence and citations as Markdown, with optional original-asset links.
- Optionally sends an image to an OpenAI-compatible vision endpoint for image explanation/captioning. Vision is opt-in and requires explicit configuration.

## Explicit non-goals and current limits

The MVP is **not** an embedding pipeline, vector database, or BM25 implementation. It does not provide complete PDF OCR, general OCR, a complete PDF layout/table parser, or a general-purpose document generator. Markdown rendering is an evidence-first draft, not a guarantee of publication-ready output. Directory ingestion only considers the supported file extensions and skips hidden directories plus `node_modules`, `dist`, `build`, and `coverage`. Remote and `data:` image URLs are not copied.

## Requirements and installation

- Node.js **>= 22.19.0** (the version declared by `package.json`).
- A Pi installation that supports TypeScript Pi packages and the package peer dependencies.

From a checked-out copy, install dependencies and validate the package:

```sh
npm install
npm run check
npm test
```

`npm test` runs the repository's `tests/*.test.ts` files through Node's type stripping. Add or provide tests before treating that command as a meaningful coverage signal; `npm run check` is the TypeScript validation gate. Do not install or commit private source material as part of setup.

## Using it with Pi

Install or link this package using the normal Pi package workflow for your environment, then enable/load the package from Pi's package configuration. The package metadata declares `./extensions/index.ts` as its Pi extension entry point and exports the implementation from `src/index.ts`; use the Pi version's package-loading documentation for the exact command or configuration syntax. If the extension entry point is not present in the checkout you received, use the exported `src/index.ts` APIs as the library surface and do not assume an interactive command is available—the MVP does not document a CLI that is not implemented.

At the API level, the main flow is: `loadConfig(cwd)` → choose `getProfile(id)` → `ingestSource(dataRoot, collection, profile, input, config)` → `loadCollection(...)` → `searchCollection(...)` → `renderMarkdown(...)`. Keep input sources outside generated data when possible.

## Configuration

| Variable | Meaning | Default |
| --- | --- | --- |
| `PI_KNOWLEDGE_STUDIO_HOME` | Overrides the data root; resolved to an absolute path | project scope: `.pi/knowledge-studio` |
| `PI_KNOWLEDGE_STUDIO_PROFILE` | Default profile ID | `general` |
| `PI_KNOWLEDGE_STUDIO_MAX_CHUNK_CHARS` | Positive maximum chunk size | `1800` |
| `PI_KNOWLEDGE_STUDIO_CHUNK_OVERLAP_CHARS` | Positive chunk overlap, capped below chunk size | `200` |
| `PI_KNOWLEDGE_STUDIO_MAX_ASSET_BYTES` | Positive copied-asset limit | `20971520` (20 MiB) |
| `PI_KNOWLEDGE_STUDIO_MAX_SOURCE_BYTES` | Positive source-file limit | `104857600` (100 MiB) |
| `PI_KNOWLEDGE_STUDIO_MAX_PDF_PAGES` | Maximum PDF page count | `2000` |
| `PI_KNOWLEDGE_STUDIO_MAX_PDF_IMAGE_PIXELS` | Maximum declared PDF image pixels | `16777216` |
| `PI_KNOWLEDGE_STUDIO_MAX_PDF_EXTRACTION_MS` | Maximum PDF load/text extraction time | `120000` |
| `PI_KNOWLEDGE_STUDIO_MAX_EXTRACTED_TEXT_CHARS` | Maximum extracted PDF text length | `10485760` |
| `PI_KNOWLEDGE_STUDIO_MAX_VISION_IMAGE_PIXELS` | Maximum declared vision image pixels | `40000000` |
| `PI_KNOWLEDGE_STUDIO_MAX_VISION_REQUEST_BYTES` | Maximum encoded vision request size | `12582912` |
| `PI_KNOWLEDGE_STUDIO_VISION_BASE_URL` | OpenAI-compatible `/chat/completions` base URL | unset; vision disabled |
| `PI_KNOWLEDGE_STUDIO_VISION_MODEL` | Vision model name | unset; vision disabled |
| `PI_KNOWLEDGE_STUDIO_VISION_API_KEY` | Vision credential | unset; falls back to `OPENAI_API_KEY` |
| `OPENAI_API_KEY` | Fallback vision credential only | unset |

## Data and safety boundaries

The default project data directory is `.pi/knowledge-studio`; global scope uses the user's Pi data area (`~/.pi/knowledge-studio`). A configured home wins. Collections contain JSON manifests/data and copied assets. Keep the data directory private, add it to backups only intentionally, and do not put credentials in it.

Treat both the source and output paths as sensitive: ingestion reads local files and may copy referenced assets; vision sends selected image bytes and the prompt to the configured endpoint. Use least-privilege directories, review collection output before sharing, and never point ingestion at secrets, credentials, private books, or an entire home directory. The package does not sanitize material for publication.

Do not package sensitive material: do not commit `.env` files, API keys, private documents, PDFs, DOCX/EPUB books, generated collections, or downloaded model files. The repository ignore rules are a convenience, not a substitute for review.

## Further reading

- [ARCHITECTURE.md](ARCHITECTURE.md) — boundaries and data flow
- [DECISIONS.md](DECISIONS.md) — MVP decisions and release posture
- [config/README.md](config/README.md) — configuration reference
- [docs/README.md](docs/README.md) — documentation and release checklist

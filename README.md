# Pi Knowledge Studio

A **generic, profile-driven Pi package** for building small, provenance-aware knowledge workspaces. The package is intentionally domain-neutral: profiles provide terminology and explanation guidance without changing the core data model. **FreeRTOS / STM32 is an optional built-in example profile, not the product scope or a required platform.**

> Two separate implementations live here: the package manifest loads both the **v1 MVP** (`extensions/index.ts`) and the **experimental v2** (`extensions/v2.ts`), with separate tools and data roots. Neither is a full production knowledge platform. The sections below describe **v1**, unless explicitly marked v2.

## Experimental v2: start here

V2 implements a local SQLite catalog and content-addressed blobs, restricted Markdown/static-HTML/TXT/PNG/JPEG/WebP/digital-PDF/DOCX capture, BM25-style lexical retrieval, optional independent dense retrieval fused with RRF, and portable MD/HTML/PNG evidence exports. Host-configured embedding, grounded-generation and vision adapters are opt-in. PDF images are decoded derivatives, not byte-identical originals; supported standalone/Markdown/DOCX/HTML PNG/JPEG/WebP originals retain their bytes. JPEG/WebP display uses separately verified PNG renditions without replacing the originals. Optional runtime reranking and source-bound retrieval-only vision hints preserve original-text authority.

```sh
cd /path/to/pi-knowledge-studio
npm install
npm run check
npm test
pi -e extensions/v2.ts
```

Use Node.js >=22.19.0 with `node:sqlite`, a compatible Pi installation, and a POSIX filesystem with owner-only data directories. Keep optional `unpdf` installed for PDF capture and optional `sharp` (including native platform packages) for JPEG/WebP capture and rendition verification at export. Installing/loading the package enables both entries; `pi -e extensions/v2.ts` is an alternative for trying only the v2 entry.

See **[V2 usage, tools, permissions and environment](docs/v2-usage.md)** for the import → search → export flow, storage location, and optional model configuration. Restricted DOCX requires Python 3 and supports main-body/table text with embedded PNG/JPEG/WebP images, not complete Office rendering. Static HTML also requires Python 3 and accepts a strict balanced, local-resource-only subset—not styled browser pages. V2 supports explicit opt-in [full-document PDF OCR](docs/ocr-usage.md) using a separately configured, pinned Linux x64 Poppler/Tesseract stack; transcripts remain explicitly unverified and page images are derivatives, not embedded originals. V2 does **not** support general Markdown/HTML parsing, automatic model service deployment, or full production deployment. Optional HTTP reranking is available with explicit host configuration and separate outbound approval; live rerank compatibility is not yet verified. V1 environment variables below do not configure v2.

## What the v1 MVP does

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

`npm test` runs the repository's `tests/*.test.ts` files through Node's type stripping, including v1 and v2 tests; passing tests is not proof of production readiness or live-model compatibility. `npm run check` is the TypeScript validation gate. Do not install or commit private source material as part of setup.

## Using v1 with Pi

Install or link this package using the normal Pi package workflow for your environment, then enable/load the package from Pi's package configuration. The package metadata declares `./extensions/index.ts` as its Pi extension entry point and exports the implementation from `src/index.ts`; use the Pi version's package-loading documentation for the exact command or configuration syntax. If the extension entry point is not present in the checkout you received, use the exported `src/index.ts` APIs as the library surface and do not assume an interactive command is available—the MVP does not document a CLI that is not implemented.

At the API level, the main flow is: `loadConfig(cwd)` → choose `getProfile(id)` → `ingestSource(dataRoot, collection, profile, input, config)` → `loadCollection(...)` → `searchCollection(...)` → `renderMarkdown(...)`. Keep input sources outside generated data when possible.

## V1 configuration

| Variable | Meaning | Default |
| --- | --- | --- |
| `PI_KNOWLEDGE_STUDIO_HOME` | Overrides the data root; resolved to an absolute path | project scope: `.pi/knowledge-studio/legacy-v1` |
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

## V1 data and safety boundaries

The default V1 project data directory is `.pi/knowledge-studio/legacy-v1`; explicit standalone global scope uses the user's Pi data area (`~/.pi/knowledge-studio`). A configured home wins. Collections contain JSON manifests/data and copied assets. Keep the data directory private, add it to backups only intentionally, and do not put credentials in it.

Treat both the source and output paths as sensitive: ingestion reads local files and may copy referenced assets; vision sends selected image bytes and the prompt to the configured endpoint. Use least-privilege directories, review collection output before sharing, and never point ingestion at secrets, credentials, private books, or an entire home directory. The package does not sanitize material for publication.

Do not package sensitive material: do not commit `.env` files, API keys, private documents, PDFs, DOCX/EPUB books, generated collections, or downloaded model files. The repository ignore rules are a convenience, not a substitute for review.

## Further reading

- [docs/v2-usage.md](docs/v2-usage.md) — current experimental v2 runtime and separate Pi entry; redesign documents are plans, not feature guarantees

- [ARCHITECTURE.md](ARCHITECTURE.md) — boundaries and data flow
- [DECISIONS.md](DECISIONS.md) — MVP decisions and release posture
- [config/README.md](config/README.md) — configuration reference
- [docs/README.md](docs/README.md) — documentation and release checklist

## Durable whole-PDF jobs

See [automatic paged PDF ingest and resumable embedding](docs/durable-pdf-jobs.md) for the additive `ks_v2_pdf_start/resume/status/search` workflow, host quotas, isolation from incomplete books, and current limitations.

V2 Studio persistence defaults to `~/.pi/knowledge-studio/` (`/root/.pi/knowledge-studio/` in the standard container): `collections/` (V2), `pdf-jobs/`, `pdf-generations/` (including model profile registry), and `exports/`. Set `PI_KS_V2_DATA_DIR` to an absolute path to override the V2 root. V1 remains project-relative under `.pi/knowledge-studio/legacy-v1/`; `PI_KNOWLEDGE_STUDIO_HOME` overrides **V1 only**. Existing project-local V2 data is not automatically moved or merged. See [storage layout and upgrade instructions](docs/storage-layout.md).

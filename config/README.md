# Configuration

This directory documents deployment and environment choices for the generic, profile-driven Pi package. Runtime configuration is read from environment variables; there is no committed secret configuration file.

## Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `PI_KNOWLEDGE_STUDIO_HOME` | Absolute data-root override | `.pi/knowledge-studio/legacy-v1` in project scope |
| `PI_KNOWLEDGE_STUDIO_PROFILE` | Default profile ID | `general` |
| `PI_KNOWLEDGE_STUDIO_MAX_CHUNK_CHARS` | Positive chunk-size limit | `1800` |
| `PI_KNOWLEDGE_STUDIO_CHUNK_OVERLAP_CHARS` | Positive overlap, bounded below chunk size | `200` |
| `PI_KNOWLEDGE_STUDIO_MAX_ASSET_BYTES` | Maximum size of each copied asset | `20971520` |
| `PI_KNOWLEDGE_STUDIO_MAX_SOURCE_BYTES` | Maximum size of each source file | `104857600` |
| `PI_KNOWLEDGE_STUDIO_MAX_PDF_PAGES` | Maximum PDF page count | `2000` |
| `PI_KNOWLEDGE_STUDIO_MAX_PDF_IMAGE_PIXELS` | Maximum declared PDF image pixels | `16777216` |
| `PI_KNOWLEDGE_STUDIO_MAX_PDF_EXTRACTION_MS` | Maximum PDF load/text extraction time | `120000` |
| `PI_KNOWLEDGE_STUDIO_MAX_EXTRACTED_TEXT_CHARS` | Maximum extracted PDF text length | `10485760` |
| `PI_KNOWLEDGE_STUDIO_MAX_VISION_IMAGE_PIXELS` | Maximum declared vision image pixels | `40000000` |
| `PI_KNOWLEDGE_STUDIO_MAX_VISION_REQUEST_BYTES` | Maximum encoded vision request size | `12582912` |
| `PI_KNOWLEDGE_STUDIO_VISION_BASE_URL` | OpenAI-compatible vision API base | unset |
| `PI_KNOWLEDGE_STUDIO_VISION_MODEL` | Vision model | unset |
| `PI_KNOWLEDGE_STUDIO_VISION_API_KEY` | Vision credential | unset; falls back to `OPENAI_API_KEY` |
| `OPENAI_API_KEY` | Fallback credential for vision only | unset |

Invalid or missing positive integer values fall back to the defaults. Vision requires both a base URL and model; its API key is optional for endpoints that do not require one.

## Data directory

`loadConfig(cwd)` uses `.pi/knowledge-studio/legacy-v1` under the current project by default. Global callers can use the user's Pi data area, and `PI_KNOWLEDGE_STUDIO_HOME` takes precedence. Collections are stored as JSON under `collections/<safe-name>/`, with copied local assets below that collection's `assets/` directory.

Keep the source and output directories private and separate where practical. Ingestion reads local source files and may copy referenced images. Optional vision sends selected image bytes and a prompt to the configured endpoint. Never ingest credentials, private books, or broad home-directory trees, and review output before sharing.

## Configuration hygiene

Use a local, untracked environment or process manager. Never commit API keys, `.env` files, private documents, generated collections, downloaded models, or book paths. The ignore rules help but are not a security boundary.

V2 Studio persistence defaults to `~/.pi/knowledge-studio/` (`/root/.pi/knowledge-studio/` in the standard container): `collections/`, `pdf-jobs/`, `pdf-generations/`, and `exports/`. `PI_KS_V2_DATA_DIR` overrides the V2 root and must be absolute. V1 remains under `.pi/knowledge-studio/legacy-v1/`; `PI_KNOWLEDGE_STUDIO_HOME` overrides **V1 only**. Existing project-local V2 data is not automatically moved or merged. See [storage layout and upgrade instructions](../docs/storage-layout.md).

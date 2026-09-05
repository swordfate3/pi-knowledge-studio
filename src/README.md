# Source layout

The `src/` tree is the implementation of the generic, profile-driven Pi package. Keep modules organized by responsibility and preserve the dependency direction described in [ARCHITECTURE.md](../ARCHITECTURE.md).

- `config.ts` — environment variables and project/global data-root resolution.
- `core/` — records, locators, stable IDs, hashes, chunking, and simple lexical scoring.
- `ingest/` — supported local text/PDF reading and referenced local-asset copying.
- `profiles/` — profile metadata and guidance. FreeRTOS / STM32 is an optional example.
- `retrieval/` — bounded lexical collection and asset search; no embeddings or BM25.
- `storage/` — JSON collection persistence and atomic writes.
- `generation/` — evidence-first Markdown rendering, not a complete document generator.
- `vision/` — optional OpenAI-compatible image provider.
- `index.ts` — public exports.

The current supported ingest types are Markdown, text/RST, HTML, JSON, CSV, and PDF text when the optional extractor is available. Avoid adding vendor, board, database, or transport assumptions to core types. Keep source and generated data outside tracked source files.

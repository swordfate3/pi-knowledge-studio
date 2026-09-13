# Source layout

`src/` contains the implementation behind the sole Pi entry, [`extensions/index.ts`](../extensions/index.ts).

- `domain/` — durable answer, evidence, OCR, retrieval, rendition, and enrichment contracts.
- `ports/` — interfaces for replaceable storage/model boundaries.
- `application/` — capture validation, retrieval/reranking, generation validation, image enrichment, PDF jobs/generations, and recovery use cases.
- `adapters/blob/` — content-addressed local blob storage.
- `adapters/storage/` — SQLite catalog schema and transactions.
- `adapters/parsing/` — bounded TXT/Markdown/image/PDF/DOCX/HTML/OCR capture workers.
- `adapters/models/` — explicit HTTP embedding, reranking, generation, and vision protocols.
- `adapters/export/` — deterministic portable Markdown/HTML and image packaging.
- `core/` — path safety, storage-root resolution, and retrieval chunk primitives.

Dependency direction and compatibility rules are documented in [`ARCHITECTURE.md`](../ARCHITECTURE.md). Keep generated data, private documents, credentials, and model artifacts outside tracked source files.

# Architecture decisions and release notes

## 0.1.0 MVP — current

- **Status:** implemented baseline / MVP.
- **Scope:** ship a generic, profile-driven Pi package rather than a FreeRTOS/STM32-specific application. FreeRTOS / STM32 remains an optional example profile to demonstrate terminology and explanation guidance.
- **Storage:** use local JSON collections plus copied local assets. This keeps installation small, makes provenance inspectable, and avoids requiring a database or model runtime.
- **Retrieval:** use simple lexical substring scoring over chunks and, when requested, asset title/caption/OCR/source metadata. This is predictable and dependency-light, but it is explicitly not embedding search, vector retrieval, or BM25.
- **Output:** produce evidence-first Markdown with source labels and optional original assets. This is a draft renderer, not a complete document generator or publication system.
- **Vision:** make image explanation an optional OpenAI-compatible adapter. It is disabled until a base URL and model are configured; callers must treat the configured endpoint as an outbound data boundary.
- **PDF:** support text extraction only when the optional `unpdf` module is available. Missing support yields a warning; the MVP does not claim complete PDF OCR, layout analysis, or table extraction.
- **Runtime:** require Node.js `>=22.19.0`, native ESM, and TypeScript. The package does not download SDKs, models, or credentials.
- **Safety:** preserve source paths, hashes, locators, and copied assets for review. Do not commit or package `.env` files, keys, private documents, PDFs/DOCX/EPUB books, generated collections, or model files.

## Rejected for this release

- Embeddings and a vector database: unnecessary infrastructure for the local MVP and not implemented.
- BM25 or a claim of full-text search quality: the implementation is only a simple lexical scorer.
- Full PDF OCR/document layout parsing: requires a larger external toolchain and has no current implementation.
- Automatic polished document generation: evidence and uncertainty need human review.
- Vendor- or board-specific architecture: conflicts with the generic profile-driven package boundary.

## Verification and publishing checklist

Before publishing a package or release note:

1. Confirm Node.js satisfies `>=22.19.0`.
2. Run `npm install`, `npm run check`, and `npm test`.
3. Review the diff and package contents; confirm no credentials, `.env`, private source material, book paths, downloaded models, or generated collection data are included.
4. Confirm documentation describes actual MVP behavior and does not call lexical search “BM25” or “embeddings.”
5. If vision is enabled in an environment, verify the endpoint, model, and data-sharing approval separately; never place the API key in tracked files.

## Revisit triggers

Revisit these decisions when search scale, OCR requirements, document publishing requirements, Pi package APIs, deployment ownership, or privacy/compliance constraints become concrete. Any future embedding, OCR, or generator feature must be documented as an explicit capability rather than implied by the package name.

# Documentation and release notes

This repository documents a **generic, profile-driven Pi package**. Keep design notes, operational guidance, and release notes here or in the root decision records. FreeRTOS / STM32 may appear as an optional example profile; it is not a required target.

## MVP release note (0.1.0)

The MVP can ingest supported text-oriented files, split text into chunks, retain hashes and source locators, perform simple lexical search, copy local Markdown/HTML image assets, and render evidence-first Markdown. Vision is optional and uses a configured OpenAI-compatible endpoint.

It does **not** implement embeddings, vector retrieval, BM25, complete PDF OCR/layout parsing, or a full document generator. PDF handling is text extraction only when the optional extractor is available, and generated Markdown needs human review.

## Maintainer verification

```sh
npm install
npm run check
npm test
```

Before release, inspect the diff and package contents. Sensitive material—credentials, `.env`, private source files, PDFs/DOCX/EPUB books, generated data, and model downloads—must not be packaged. Do not include machine-specific absolute paths or credentials in docs. Keep release claims aligned with the implementation and record future capability changes in [DECISIONS.md](../DECISIONS.md).

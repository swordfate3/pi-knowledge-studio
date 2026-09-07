# Documentation and release notes

This repository documents a **generic, profile-driven Pi package**. Keep design notes, operational guidance, and release notes here or in the root decision records. FreeRTOS / STM32 may appear as an optional example profile; it is not a required target.

## Multimodal redesign (implementation in progress)

- [Implemented experimental slice: portable original-image export / 已实现范围与限制](portable-export-slice.md)

- [Visual overview / 图解](multimodal-redesign.html)
- [Architecture and audit evidence / 架构提案](multimodal-redesign.md)
- [Phases, migration and acceptance gates / 验收计划](redesign-validation.md)

The original full architecture remains a design target, not a completed production claim. Experimental v2 now includes SQLite/CAS persistence, restricted multi-format capture, hybrid retrieval, optional model adapters and additive Pi tools. The portable-export note above is historical and does not describe the entire current implementation.

### Current implementation and acceptance

- [Implementation progress and remaining gaps](IMPLEMENTATION-PROGRESS.md)
- [Active five-gate delivery acceptance](DELIVERY-ACCEPTANCE.md)
- [V2 usage, permissions and format limits](v2-usage.md)
- [Retrieval evaluation and its limitations](retrieval-evaluation.md)
- [Offline storage recovery and retention](storage-recovery.md)
- [OCR prerequisite feasibility](ocr-feasibility.md)
- [Interactive visual progress explanation](studio-status-visual.html)

The visual progress page is a dated snapshot; current acceptance evidence takes precedence.

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

## Durable whole-PDF jobs

See [automatic paged PDF ingest and resumable embedding](durable-pdf-jobs.md) for the additive `ks_v2_pdf_start/resume/status/search` workflow, host quotas, isolation from incomplete books, and current limitations.

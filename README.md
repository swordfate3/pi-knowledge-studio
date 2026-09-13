# Pi Knowledge Studio

Pi Knowledge Studio is the multimodal knowledge-base extension for Pi. It imports local documents into a provenance-aware store, retrieves lexical or hybrid evidence, and generates portable Markdown/HTML packages that can reuse captured source images.

The repository ships one product implementation and one Pi extension entry: `extensions/index.ts`.

## Capabilities

- Imports TXT, Markdown, PDF, DOCX, static HTML, PNG, JPEG, and WebP.
- Captures native text and supported source images with stable provenance.
- Supports lexical retrieval by default and optional hybrid embedding retrieval.
- Supports optional reranking, OCR, generation, and image enrichment through separately approved model or local-process boundaries.
- Generates evidence-grounded Markdown/HTML packages with selective source figures.
- Provides a durable native-PDF workflow with pause/resume and immutable index generations.
- Stores runtime data outside the source tree at `~/.pi/knowledge-studio/` by default.

## Requirements

- Pi coding agent with extension loading enabled.
- Node.js 22.19 or later.
- Python 3 for DOCX and static HTML import.
- Poppler tools (`pdftotext`, `pdftoppm`) for configured PDF/OCR workflows.
- Optional model credentials/configuration for embeddings, reranking, generation, OCR, vision description, and image enrichment.

## Install

Install directly from GitHub:

```bash
pi install git:github.com/swordfate3/pi-knowledge-studio
```

Or clone and install the local package:

```bash
git clone https://github.com/swordfate3/pi-knowledge-studio.git
cd pi-knowledge-studio
npm install
npm run check
npm test
pi install .
```

Pi loads `extensions/index.ts` through the manifest in `package.json`. To load the checkout explicitly:

```bash
pi -e ./extensions/index.ts
```

Restart Pi (or run `/reload`) after installing or updating the extension.

## Quick start: `/studio`

The recommended interface is the discoverable slash command:

```text
/studio
```

It opens an interactive menu for importing, listing, searching, exporting, generating, and native-PDF workflows. Commands with explicit arguments are also available:

```text
/studio import freertos "docs/FreeRTOS 笔记.md"
/studio list freertos
/studio search freertos "优先级继承如何工作？"
/studio export freertos priority-evidence "互斥量与优先级继承"
/studio generate freertos priority-guide "优先级继承详解" | "互斥量与优先级继承"
/studio pdf "books/FreeRTOS 内核.pdf"
/studio books book_<64位哈希>
/studio book-search book_<64位哈希> "任务切换如何实现？"
/studio help
```

The command starts the appropriate Studio workflow through Pi and preserves every existing file-access, disclosure, model-egress, and export confirmation. It does not grant capabilities or bypass approvals. See [`docs/usage.md`](docs/usage.md) for full syntax and limits.

## Tools

### General collections

- `ks_v2_import`
- `ks_v2_search`
- `ks_v2_index`
- `ks_v2_export`
- `ks_v2_generate`
- `ks_v2_describe_image`
- `ks_v2_document`
- `ks_v2_enrich_image`
- `ks_v2_remove`
- `ks_v2_list`

### Native PDF books and index generations

- `ks_v2_pdf_start`, `ks_v2_pdf_resume`, `ks_v2_pdf_status`, `ks_v2_pdf_search`
- `ks_v2_profile_list`, `ks_v2_profile_add`, `ks_v2_profile_select`
- `ks_v2_pdf_migrate`, `ks_v2_pdf_generation_associate`, `ks_v2_pdf_reindex`
- `ks_v2_pdf_generation_status`, `ks_v2_pdf_generation_pause`, `ks_v2_pdf_generation_cancel`, `ks_v2_pdf_generation_resume`
- `ks_v2_pdf_generation_activate`, `ks_v2_pdf_generation_rollback`, `ks_v2_pdf_generation_search`

The `ks_v2_*` identifiers are compatibility-stable public tool names. They do not indicate a second bundled implementation.

## Confirmation and privacy model

Knowledge Studio keeps capability boundaries explicit:

- Import reads only a user-approved local path.
- Search/list disclose bounded evidence or metadata to the active conversation/model provider.
- Indexing sends captured text to the configured embedding endpoint; hybrid search sends the query.
- Reranking sends the query and candidate text to the configured reranker.
- Generation sends only the selected evidence bundle to the configured generation model.
- Image description/enrichment sends only the approved image and prompt to the configured vision model.
- Export writes a portable package containing selected full text/images.
- Remove changes the active catalog but does not promise secure erasure from blobs, backups, exports, or history.

See [`docs/usage.md`](docs/usage.md) for exact approvals, limits, and host configuration.

## Storage

Default runtime root:

```text
~/.pi/knowledge-studio/
```

Override it before starting Pi with the compatibility-stable variable:

```bash
export PI_KS_V2_DATA_DIR=/absolute/private/path
```

Generated packages are written below:

```text
~/.pi/knowledge-studio/exports/<output>/<unique-package>/
```

The removed V1 JSON store is not opened or migrated in place. If old data is detected, Knowledge Studio fails closed; back it up and follow [`docs/storage-layout.md`](docs/storage-layout.md).

## Development

```bash
npm install
npm run check
npm test
npm pack --dry-run
```

Architecture notes live in [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Scope limits

- OCR output and vision-derived hints are untrusted candidates, not source quotations.
- Native-PDF jobs support text-native PDFs; OCR is a separate bounded import workflow.
- HTML import is static only: no scripts, active content, CSS rendering, or network fetch.
- DOCX import is deliberately bounded to main-body text and supported embedded image formats.
- Packaging preserves provenance and source assets, but package IDs are not byte-stable across exports.
- Tests and validation evidence do not establish production-scale quality, latency, or multi-user isolation.

# Storage compatibility: native PDF capture

Native PDF imports now use recipe `local-native-pdf-window5-chunk800-v3`.
TXT/Markdown, DOCX/HTML, image and full-document OCR recipes are unchanged.
No catalog schema migration is required. Existing stored revisions remain readable;
reimporting the same absolute PDF path keeps its document ID but publishes a new
revision using the new recipe. Rebuild embedding indexes for that new revision;
old vectors/chunk IDs are not interchangeable with the new overlapping chunks.

## Built-in behavior and limits

- One original PDF blob/source hash and document ID; no temporary derivative PDFs,
  pypdf, external splitting command or new dependency. Fresh isolated Node workers
  reopen the original bytes for sequential windows of at most five physical pages.
- Strict `totalPages/start/end/pages` protocol: parent validates consistent total,
  exact window length and page sequence, rejecting duplicates, gaps and reordering.
  Empty windows are valid; a document without any extractable non-whitespace text
  fails. Blank pages have no fabricated text element; subsequent page locators do
  not shift. This is not full visual/text coverage certification.
- All windows and chunk counts validate before image blob writes. `captureLocal`
  stages the original and images until capture validation succeeds; runtime only
  publishes the complete document. Aborts kill active workers and remove timers
  and abort listeners. Storage failures/cancellation during final blob flushing
  can leave unreferenced blobs, but do not publish a partial catalog revision.
  Final persistence checks cancellation/deadline before and after each write and
  refuses late success. This is cooperative: an in-flight blob-store operation
  is not interruptible, so 120 seconds is not a hard wall-clock I/O termination guarantee.
- Unchanged caps: 20 MiB input, 200 total pages, 100 images, 4M pixels/image,
  8M aggregate pixels, 100K extracted UTF-16 characters/page, 1M/document,
  5,000 elements. Worker heap 192 MiB, monitored RSS 512 MiB, output 48 MiB,
  stderr 16 KiB. Each worker gets at most 30 seconds of the 120-second total
  capture deadline. RSS polling is not an OS hard quota; isolation is not a sandbox.
- Page-local retrieval spans target 800 characters, maximum 1,200, overlap about
  100. They prefer paragraph/newline/sentence boundaries and preserve surrogate
  pairs and all extracted whitespace. Overlap intentionally duplicates text;
  the union of spans covers the exact extracted source text. This does not recover
  text PDF.js itself fails to extract. Images link to **all same-page chunks**,
  not semantically selected passages.
- Audited `unpdf` 1.8 API: `extractImages(pdfProxy, pageNumber)` uses that page's
  `getOperatorList()`; `withDocument` recognizes the supplied proxy and does not
  reopen/traverse the full PDF. Only supported `paintImageXObject` bitmaps are
  captured as decoded PNG derivatives, not original encoded image bytes.

## Offline single-file acceptance (2026-09-07)

Exactly one runtime ingest of the existing `source/first50.pdf` from
`freertos-first50-20260906T164656Z` succeeded in 3,484 ms, into new experiment
a private local experiment directory (path omitted).
This is the existing 50-page input, not the adjacent 943-page `original.pdf`.

- One document after catalog reopen; exact original bytes retained.
- SHA-256: `8de2de01bb4de4771ab4ea13ed78db24f926a061c88f493bf2800c4b331c031a`.
- 50 physical pages validated, 45 retrieval elements, 22 image occurrences;
  pages 2 and 23 produced no native text or supported bitmap. No page renumbering.
- Read-only post-import worker audit: 10,343 extracted characters, 3,529,122 image
  pixels; current chunk recipe exactly matches retained elements. `result.json`
  and `page-audit.json` retain the evidence outside the repository.
- No remote embedding, network inference or service changes. Old experiments
  unchanged; no copyrighted input assets copied into this repository.

This is **not** acceptance of the 943-page book (still over the 200-page cap),
scanned/OCR quality, complete image extraction, or arbitrary PDFs: a single complex
page can still exceed the worker memory/time budget and will fail explicitly.

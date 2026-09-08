# Durable whole-PDF jobs (additive V2)

Pass the **whole local PDF**, not manually split files. These tools use an independent private book store, not the bounded `ks_v2_import` route or existing collection catalog.

```text
ks_v2_pdf_start  {"path":"books/manual.pdf","index":true}
ks_v2_pdf_status {"bookId":"book_<source SHA-256>"}
ks_v2_pdf_resume {"bookId":"book_<source SHA-256>","index":true}
ks_v2_pdf_search {"bookId":"book_<source SHA-256>","query":"scheduler","mode":"hybrid"}
```

`index` defaults to false: parse locally now, approve indexing on resume later. Tools require existing trusted `import`, `index`, `embedding`, `list`, and `search` grants as appropriate. Embedding uses the existing host `PI_KS_V2_EMBED_*` configuration and purpose-specific approval. No model is enabled implicitly. No URL resources, vision, OCR, or image egress. Source metadata/text returned by tools is disclosed to the conversation/provider/log under the corresponding approval.

## Lifecycle and persistence

- `PdfJobs` application API in `src/application/pdf-jobs.ts`: `start(sourceRoot,path,signal?)`, `resume(bookId,{provider?,signal?,onProgress?})`, `status(bookId,signal?)`, `search(bookId,query,limit?,signal?,provider?)`.
- `start` streams and hashes input into a private immutable spool with 64 KiB buffers. Content-addressed `bookId` groups every window under the exact whole-source hash. Same bytes reuse the job, regardless of filename. The original file is no longer needed on resume.
- `resume` automatically walks physical pages in five-page windows. Each worker receives an already-open source descriptor; PDF.js requests bounded ranges, not another full source copy through stdin. Each child has its own lifetime and resource limits.
- Validated native text chunks, physical page numbers, decoded bitmap PNGs and window checksum commit together with the page checkpoint in a SQLite transaction. Blank/scanned pages are recorded as processed, **not as successfully transcribed**.
- **All parsing finishes before embedding begins** in this slice. Embedding proceeds serially, at most four text chunks per request. Each validated finite, nonzero vector batch and its source/parser/model/text/offset/vector checksum binding commit atomically with progress. No hidden retry. A crash after provider success but before commit can repeat that one uncommitted request (exactly-once billing is not possible).
- Separate SQLite write reservation covers the full operation, including child/provider waits; concurrent access fails promptly. Process death releases the lock and SQLite rolls back incomplete transactions. Status also takes the lock and verifies the source and all committed checkpoints; it is not a nonblocking live monitor. Running tools emit progress updates after commits.
- Cancellation kills the parsing child and leaves committed windows/batches intact. Provider cancellation remains cooperative: the existing HTTP adapter can finish its in-flight request (30-second transport deadline), but an aborted response is not checkpointed. Resume is explicit.
- `parsing → parsed → indexing → ready`. `ready` means all native page windows and configured vectors committed, **not complete OCR, layout, original-image extraction, or semantic accuracy**.
- No fragments are published into existing collections. Dedicated search refuses every non-ready job, including lexical search. Ready search scans bounded windows and maintains only top-k hits, returns one book ID and original physical pages. Hybrid adds positive cosine similarity to normalized lexical term matches; it is not the collection runtime's RRF/BM25 pipeline.

## Storage and quotas

Linux/POSIX only for this route. Store: `~/.pi/knowledge-studio/pdf-jobs/` (`/root/.pi/knowledge-studio/pdf-jobs/` in the standard container, or `PI_KS_V2_DATA_DIR/pdf-jobs/` when overridden), owner-only directory and regular files. Descriptor-relative ancestor traversal and no-follow leaf opens reject symlinks; spool/database paths are derived exclusively from validated hashes. SQLite uses FULL synchronous rollback journaling. Existing databases (including the lock DB) must match the exact v1 schema allowlist, with no unexpected tables, indexes, triggers or views, before application reads/writes; only newly created empty databases are initialized. SQLite journal recovery remains allowed. SQL-side byte-length/type predicates reject oversized JSON, checksum fields and image BLOBs before returning values to JavaScript. Physical database size and 4096-byte page configuration are checked before checkpoint verification. Manifest/window/vector validation fails closed; corruption is not repaired by deleting previous jobs. An orphan spool can be reused only after hashing against the incoming source.

Host-only settings (positive safe integers, snapshotted when the extension loads):

| Setting | Default | Meaning |
|---|---:|---|
| `PI_KS_V2_PDF_MAX_INPUT_BYTES` | 536870912 (512 MiB) | Streaming source input bound |
| `PI_KS_V2_PDF_MAX_STORAGE_BYTES` | 4294967296 (4 GiB) | Per-job source + database/journal budget |

Disk budgeting reserves source bytes plus 1 MiB overhead, and splits the remainder between database and rollback journal via SQLite `max_page_count`. Temporary creation/repeated start can additionally require one input-sized spool. These are **per-job limits**, not a filesystem-wide quota: multiple jobs and crash-left random spools need host disk management. No automatic deletion/GC is implemented. Do not lower/change persisted job quotas on resume; identity drift fails closed.

There is **no fixed total page count cap** on this job route. It is not an arbitrary-size guarantee:

- Five pages per child; 30 seconds/child, 192 MiB V8 heap, 512 MiB RSS sampled by the child and, on Linux, by the parent via `/proc/<pid>/status` approximately every 50 ms, 48 MiB stdout, 16 KiB stderr.
- At most 100,000 native text characters/page; 1M text characters, 100 decoded images, 8M aggregate pixels/window; 4M pixels/image; 5,000 elements/window; 8 MiB JSON/checkpoint record.
- PDF range requests are at most 8 MiB. Complex cross-reference structures, pathological single pages or oversized range requests fail explicitly. PDF.js allocates a source-length backing buffer even with range transport; its metadata and source buffers scale with file size. The default 512 MiB input policy is not a guarantee that an accepted source can be parsed within 512 MiB RSS. Sampling can miss spikes or overshoot, and parent/proc scheduling or availability can delay observation; RSS monitoring is not a hard OS memory quota/security sandbox.
- Per-window result size is bounded independently of total page count, but total parser memory is not: PDF.js metadata and source-length buffers scale with the file. No arbitrary-size memory guarantee is made. Source verification streams the entire spool once on every status/resume/search (I/O proportional to file size); checkpoint verification scans the job. Large books can take a long time, even without model calls.

Native extraction has the same fidelity limitations as legacy PDF capture: decoded embedded bitmap derivatives are **not original compressed image bytes**; unsupported inline images/masks/vectors may be absent; image links mean same physical page only. The complete original PDF is preserved in the spool.

## Scope and residual gaps

This is an integrated durable ingest/index + dedicated ready-book retrieval slice, not full parity with collections. No book image-read/export/generation API, collection promotion, job list/delete/GC, background scheduler, OCR, interleaved parse/index scheduling, or hard OS disk/RSS sandbox is provided. Model/source/parser/quota changes require a different workflow, not silent reuse of vectors. Host private roots protect against accidental path misuse, not malicious same-user processes modifying files concurrently.

The automated scoped tests use synthetic PDFs/providers, including a real 205-page PDF with decoded images, failure/restart/batch idempotence, original page 205, model drift, corruption, symlink paths, input quota, concurrent locks and a killed process with an open batch transaction.

### Separately authorized real-book experiment (2026-09-07)

The main process also exercised the public application API against the user's original 943-page FreeRTOS PDF (8,065,053 bytes), without manually splitting it. Persistent artifacts remain in a private local experiment directory and are not distributed with this repository. Parsing completed 189 automatic windows in 88,559 ms; storage contains 1,007 text chunks and 187 decoded PNG occurrences (187 unique images). The original whole-source hash identifies one book; these are not 189 independently imported books.

With the user's prior book-text/query-only authorization, existing WeMM-Embedding-4B (revision `a28b25c5d18cf71ec46b115e06ea79ab00ee4819`, 512 dimensions, empty instructions) indexed all 1,007 chunks in 366 serial requests, 227,677 ms, ending `ready` with 189 indexed windows. A separate process verified all source/checkpoint/vector bindings via `status` and performed two query embeddings/searches. `vTaskDelay` returned pages 233/170/434/433/438; a Chinese queue-communication query returned 460/462/500/464/495, including a stored image reference on page 462. These are smoke results, not judged retrieval-quality metrics or visual verification. No PDF/image/GPT transmission or service changes. This job's model-space provider identifier is experiment-specific; silently reusing it with a different extension configuration is deliberately rejected.

Independent main regression: typecheck passed; 237 tests, 227 passed, 10 skipped (including unavailable OCR environment and ownership-dependent cases), zero failures. No real OCR rerun. End-to-end live Pi execution of the four new tools and image delivery/export parity remain unverified/unimplemented respectively.

Follow-up scoped cases also cover trigger/view/table/lock-schema rejection without file changes, oversized SQL values (including NUL-containing text), physical DB quota rejection before manifest parsing, and deliberate finite vector-payload corruption. Schema and manifest version remain v1; structurally unchanged existing v1 jobs are not migrated or invalidated.

## Profile-backed shadow rebuilds

The separate [PDF model profiles and generations](pdf-model-profiles.md) store now
supports explicit non-destructive v1 import, immutable model revisions, durable
shadow rebuilding and CAS activation/rollback. Existing v1 tools/schema are not
redirected or migrated in place. The new path has synthetic-test evidence only;
the earlier real-book measurements do not certify this new generation store.

Storage upgrade: see [default layout and manual migration](storage-layout.md). Old project-local roots are never moved automatically.

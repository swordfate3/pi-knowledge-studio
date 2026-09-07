# FreeRTOS text embedding diagnostic — completed after explicit contention approval

Date: 2026-09-06. Current status: **full text-vector diagnostic completed; not production PDF ingestion or overall quality acceptance**.

## Completed live run (latest result)

The user explicitly approved reusing the loaded GPU service despite contention. The frozen test then completed with no retries, no service/tunnel changes, and no PDF/image/GPT transmission:

- 1,316 document chunks and 17 queries embedded and persisted as 512-dimensional vectors, empty query/document prefixes.
- 329 serial document batches plus five query batches: **334/334 requests completed**, maximum four texts per request.
- Elapsed **276650 ms (4 min 36.65 s)** including indexing, query embeddings and scoring. No inference failures in this attempt.
- Model: `tencent/WeMM-Embedding-4B`, revision `a28b25c5d18cf71ec46b115e06ea79ab00ee4819`. Same service identity checked before requests; health remained ready afterwards.
- All document batches were reopened and verified before query embedding. A separate main process subsequently reopened all **1,333 vectors**, verifying manifest/model/text bindings, dimensions, finite nonzero vectors and unchanged original PDF hash. This is diagnostic-file persistence evidence, not production SQLite recovery acceptance.
- Authoritative live output: `/tmp/freertos-embedding-diagnostic-fnF8is/complete.json`; `attempt.json` is complete. Historical `report.json`/manifest retain the pre-inference blocked state, and `progress.json` is only the last document-index checkpoint. Do not mistake those historical/partial snapshots for the final outcome.

### Frozen-question results

Physical pages deduplicated; 14 evaluator-authored positive questions:

| Method | Hit@1 | Hit@5 | MRR@10 |
| --- | ---: | ---: | ---: |
| Lexical | 7/14 (50.0%) | 11/14 (78.6%) | 0.6423 |
| Dense, 512-dimension / no instructions | 5/14 (35.7%) | 6/14 (42.9%) | 0.4039 |
| Equal-weight RRF hybrid | 6/14 (42.9%) | 13/14 (92.9%) | 0.6095 |

Hybrid improved this diagnostic's top-five judged-page coverage but not first-result accuracy or MRR. Dense-only performed weakly in this configuration. This does not isolate model capability from dimensionality, instruction profile, chunking or non-exhaustive page labels; no causal claim or post-hoc gold correction is made. Q05 missed the judged page in all methods' top five. Topically relevant alternative pages may be unjudged. Do not call 92.9% an overall answer accuracy or complete corpus recall.

The three expected negatives only have ranked candidates; they do not establish safe abstention. No GPT, visual interpretation, image retrieval, answer correctness or production full-book import was tested. The 200-page production PDF cap still blocks direct ingestion of this 943-page book. The stored index is temporary diagnostic data under `/tmp`, not an installed or durable production knowledge base.

## Historical preparation record (before approval)

The following records the initial **ready-but-contention-needs-approval** stage. Its zero-request counts and unexecuted-path statements are historical, superseded by the live result above.

## Safety and scope

Only locally extracted book text chunks and frozen test queries are authorized for the registered embedding1 service. No PDF bytes, images, GPT requests, installed knowledge-base changes, lifecycle operations, or tunnel changes occurred. Read-only health/OpenAPI requests and GPU status checks were performed; **embedding inference requests: 0; persisted vectors: 0**.

Source SHA-256 was checked against the extraction report before preparation and again after local evaluation: `65a8dbd825f3a409aa77d85c4282df3997bcb397ea9a0838cd3c84b7a6dab4b1`. Source unchanged.

At 15:37:39 UTC GPU utilizations were 80% / 84%; at 15:37:45 UTC they were 71% / 80%. Both checks exceed the requested 40% contention gate. Existing WeMM health remained ready, model `tencent/WeMM-Embedding-4B`, revision `a28b25c5d18cf71ec46b115e06ea79ab00ee4819`, full dimension 2560, process 18660, cuda:0. Readiness does not authorize additional contentious load.

## Frozen local test

Private artifacts: `/tmp/freertos-embedding-diagnostic-fnF8is/` (directory mode 0700).

- `manifest.json`: immutable scope, hashes, model profile, budgets and evaluation rules.
- `chunks.json`: 1,316 chunks covering all 925 nonempty physical pages; no page merging. Up to 800 Unicode code points, overlap 100, half-open code-point offsets, per-chunk text hashes and source hash. Surrogate pairs are not split.
- `pages-ledger.json`: all 943 physical pages, including 18 explicitly empty pages.
- `gold.json`: 17 distinct Chinese questions, 14 positives and 3 expected out-of-book negatives; API identifiers, code, concepts and paraphrases. Relevant physical pages were manually inspected and frozen before this test's scoring.
- `run.mjs`: offline verification and explicitly gated execution; `README.md` documents approval requirements.
- `status-1.txt`, `status-2.txt`, `service-openapi.json`: read-only service observations.
- `lexical.json`: local baseline and individual rankings; `report.json`: machine-readable blocked result.

Manifest SHA-256: `cff7ec46b67c35f8d3f700983f429bc50e74d389b25f6654e5f37aaae45040f7`.

Planned embedding profile: 512 dimensions; empty query/document instruction prefixes, consistent with the earlier verified synthetic WeMM profile. 329 document batches plus 5 query batches, maximum 4 texts per serial request, no retries, 60-second timeout, maximum 10-minute attempt. The first small document batch is the latency probe. Full indexing may not fit this budget. Query embedding cannot begin before all document batches are persisted and reopened successfully. Partial work is retained but never called complete or resumed automatically.

The runner reuses existing `boundedJsonPost`, `lexicalRank`, `cosine`, and `reciprocalRankFusion`. `HttpEmbeddingProvider.embed` currently uses a fixed 30-second transport timeout, so the diagnostic uses its bounded transport with explicit 60 seconds and equivalent strict WeMM identity/vector validation, without source changes or fallback. Syntax and offline paths passed; the inference path has **not been exercised**.

## Local-only results (not an embedding comparison)

Across the 14 positives, physical pages are deduplicated before scoring:

| Method | Hit@1 | Hit@5 | MRR@10 |
| --- | ---: | ---: | ---: |
| Existing lexical helper | 7/14 (50.0%) | 11/14 (78.6%) | 0.6423 |
| Dense | Not run | Not run | Not run |
| Hybrid RRF | Not run | Not run | Not run |

Gold is evaluator-authored, non-exhaustive, and **not independent heldout**; earlier anchor rankings had already been exposed. These are judged-page diagnostic hits, not precision or exhaustive corpus recall. Expected negatives have no proof of absence across the entire book and receive descriptive rankings only, not negative accuracy or calibrated abstention metrics. No generated-answer quality was tested.

## Remaining gate and limitations

Wait for safe fresh GPU checks, or obtain explicit user approval to add load despite contention. No automatic continuation. A stopped partial attempt needs separate resume approval; completed validated batches are reused.

This is a native-text diagnostic over a separately extracted corpus, not successful production full-PDF ingestion: the existing Studio parser still rejects this 943-page PDF at its 200-page budget. No OCR, image retrieval, original-image reuse, multimodal or answer-generation claim is supported. `/tmp` artifacts are temporary, not a durable production deployment. This document contains no book excerpts, vectors or secrets.

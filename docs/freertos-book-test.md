# FreeRTOS book — local feasibility test (2026-09-06)

## Verdict

The book has usable native Chinese text and searchable identifiers. A high-quality knowledge base is plausible, but **the current v2 Studio cannot import the whole book**, and **embedding quality has not been tested**. This is a diagnostic feasibility report, not successful ingestion or acceptance.

## Input and isolation

- Source: a privately supplied FreeRTOS reference PDF (local filename and storage path omitted)
- Size: 8,065,053 bytes (~7.69 MiB).
- PDF pages: **943**. All page numbers below are PDF physical positions, not printed book page numbers.
- Artifacts: `/tmp/freertos-book-test-YMkEPg/report.json`, `pages.json`, `image-sample.json`, `identifier-search.json`.
- Probe scripts: `/tmp/freertos-book-probe.mjs`, `/tmp/freertos-image-probe.mjs`.
- New temporary collection only. Existing knowledge bases and source unchanged. No network/model requests, no remote embedding, no OCR. Extracted book text stays in temporary local artifacts, not this repository.

## Actual import: failed

`KnowledgeRuntime.ingest()` rejected the original PDF:

```
PDF parsing failed: PDF page budget exceeded
```

The v2 worker and parent validate at most **200 pages**. The file fits the 20 MiB input limit. A separate reviewer reproduced the capture failure with **zero blob writes**. The failed runtime attempt can create an empty catalog; it does not establish a published book.

Do not simply change 200 to 1000: image count, cumulative image pixels, worker timeout, and parent validation are additional bounded constraints. The older ingestion configuration's page setting does not override v2. Full-document OCR is limited to 20 pages, not a whole-book workaround.

## Diagnostic extraction outside the production import path

A local, network-disabled unpdf diagnostic loop inspected all 943 pages, retaining per-page text in memory and temporary JSON. It did not relax production limits or publish a replacement book capture.

- Extracted native text: **613,759 JavaScript string characters**.
- Nonempty text pages: **925**; **18** have no native text.
- **102** pages have fewer than 80 characters (including empty pages).
- Unicode replacement characters: **0**. This does not prove no recognition, encoding, or reading-order errors.
- Extraction phase: approximately **5.7 seconds** in this run; not an ingestion SLA.
- Spot-read Chinese explanations and C identifiers were readable. Code line numbers, hard wraps and cross-page fragments remain; extracted code is not certified compilable or byte-identical to official source.
- Short/empty pages need page-image inspection before declaring missing content; they may be covers, illustrations, blank pages, or unextracted content. No full-page visual audit performed.

## Local lexical retrieval: useful, not high-quality acceptance

Used the existing `lexicalRank` on diagnostic page text, **not** a persisted Studio book, embedding, or GPT generation.

Five identifier queries all returned exact-containing top-one pages:

| Query | Top PDF page |
|---|---:|
| `vTaskDelay` | 250 |
| `pxPortInitialiseStack` | 105 |
| `xQueueSend` | 485 |
| `xSemaphoreTake` | 553 |
| `xEventGroupWaitBits` | 667 |

These are identifier lookup checks, not independent relevance/answer coverage scores.

Ten Chinese questions were also run. Examples:

- Queue communication: top page **459**, the queue basics section; spot-read content is relevant.
- Binary semaphore synchronization: top page **555**, the synchronization experiment; spot-read content is relevant.
- Event-based wake-up: top page **641**, the event basics section; spot-read content is relevant.
- “让任务休眠一段时间应该使用什么函数？”: top page **707**, about starting a software timer, rather than the expected task-delay API. Querying `vTaskDelay` directly finds its pages. This demonstrates a wording mismatch needing semantic retrieval or model-led query refinement.

Each diagnostic question had an expected anchor string, but anchor presence/absence is **not a gold relevance label**. Relevant conceptual pages may not name the API. No percentage recall/accuracy is claimed from these probes.

## Pictures: partial inventory only

Ten sampled pages were checked for supported decoded embedded bitmaps. Pages **1, 60, 64** returned one bitmap each; seven other sampled pages returned none. No whole-book image inventory, pixel inspection or completeness assessment was performed.

Studio's native PDF adapter stores decoded PNG derivatives, **not original embedded image byte streams**. Links currently mean same page, not precise figure-to-paragraph association. Unsupported vectors, masks and inline images may be omitted. This is a real boundary for original-figure reuse; do not label these derivatives as original image bytes.

## Next validation steps

1. Add bounded whole-book ingestion: page/chapter batches, preserved original PDF hash and original physical page mapping, resumable progress and explicit partial/failure state. Do not bypass guards or silently truncate.
2. Inspect short-text/image/code-heavy pages and verify figure associations. Keep original PDF; distinguish extracted bitmap, page render and original embedded bytes.
3. Freeze question/evidence pairs across chapters, including paraphrases, API names, code, figures and absence cases. Verify relevance manually, separate from anchor-string checks.
4. With explicit user approval, send book text chunks and test queries to the confirmed remote embedding service; store vectors only in a new test collection. Record exact model/revision/dimension/instructions and complete coverage.
5. Compare lexical versus hybrid retrieval on the same frozen questions. Reopen the new collection and check persistence/source integrity. No GPT answer score is needed to establish this retrieval baseline.

Remote approval must specify endpoint/model and content scope. Embedding normally needs text chunks, not the PDF file or image pixels; this is still transmission of book content. No such transmission occurred in this test.

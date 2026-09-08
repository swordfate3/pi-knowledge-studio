# Experimental v2 usage

This guide describes `extensions/v2.ts` and `src/application/knowledge-runtime.ts`, not the legacy v1 APIs in `src/index.ts`. The package manifest loads both `extensions/index.ts` (v1) and `extensions/v2.ts`, with separate tool names and data roots; there is no automatic v1 collection migration. Redesign plans and the older portable-export slice document are not the current feature contract.

## Install and run

Requirements: Node.js **>=22.19.0** with built-in `node:sqlite`, a Pi installation exposing the extension APIs used here (including `withFileMutationQueue`), and a POSIX filesystem. Native Windows permission semantics are not supported by the v2 entry's owner checks; use an appropriate Linux filesystem. PDF parsing needs the optional `unpdf` dependency and permission to spawn a Node child process. Restricted DOCX and static HTML parsing need `python3` (standard library only) and permission to spawn an isolated Python child process. JPEG/WebP capture and export additionally require the optional `sharp` native decoder and a Node child process. Decoder versions form part of the rendition recipe: keep the recorded decoder version available for exporting existing renditions; a version mismatch fails rather than silently changing images.

```sh
cd /path/to/pi-knowledge-studio
npm install                 # optional unpdf for PDF; optional sharp for JPEG/WebP
npm run check
npm test
pi -e extensions/v2.ts
```

No separate compile step or model service is needed for lexical retrieval and evidence export. The checks above are validation commands, not a claim that every remote model has been tested. A normal `pi install /path/to/pi-knowledge-studio` uses the manifest and enables both v1 and v2 after loading/reloading the package. The explicit `-e` example is an alternative for trying the v2 entry.

For a separate source workspace, install dependencies in the checkout first, then run:

```sh
cd /path/to/private-workspace
pi -e /path/to/pi-knowledge-studio/extensions/v2.ts
```

Source input paths are relative to the **Pi working directory**, not to the extension checkout. V2 persistent data and outputs default to `~/.pi/knowledge-studio/` (`/root/.pi/knowledge-studio/` in the standard container), independent of the working directory. Set `PI_KS_V2_DATA_DIR` to an absolute path before starting Pi to use another private root; the value is snapshotted when the extension registers. Extension registration performs no filesystem writes or network calls. Existing project-local V2 data is not automatically moved or merged; see [storage layout and upgrade instructions](storage-layout.md).

## First local workflow

Place a non-sensitive `notes.md` or `notes.txt` inside the workspace. In Pi, ask the assistant to call the tools below with these arguments (these are tool calls, not shell commands):

```text
ks_v2_import  {"collection":"demo","path":"notes.md"}
ks_v2_list    {"collection":"demo"}
ks_v2_search  {"collection":"demo","query":"a term present in your notes","mode":"lexical","limit":5}
ks_v2_export  {"collection":"demo","query":"a term present in your notes","output":"first-export"}
```

Approve each requested action in the trusted Pi confirmation UI. Search with no relevant hits reports an error rather than inventing an answer. `ks_v2_export` is deterministic **evidence compilation**, not model-generated prose; bundle/package UUIDs mean repeated exports are not byte-identical.

Exports are unique packages below `~/.pi/knowledge-studio/exports/<output>/` (or the configured `PI_KS_V2_DATA_DIR/exports/`), containing `document.md`, `document.html`, image assets and `sources.json`, `evidence.json`, `manifest.json`. JPEG/WebP originals are retained alongside separate PNG display renditions; provenance identifies both. Original bytes are not replaced by the display conversion. Keep the whole package together for offline viewing/sharing. Outputs include sensitive text and provenance; nothing is redacted.

## Tools

Collection and output names match `^[a-z0-9][a-z0-9_-]{0,63}$`. Queries are 1–8000 characters (runtime rejects blank queries). Optional `mode` is `lexical` (default) or `hybrid`; optional `limit` is 1–10, default 5 where exposed.

| Tool | Arguments | Effect and approvals |
| --- | --- | --- |
| `ks_v2_import` | `collection`, `path`, optional `ocr` | Import one file and permitted linked PNG/JPEG/WebP images; `import` approval. PDF-only `ocr: true` additionally requires host `PI_KS_V2_OCR_CONFIG` and separate `ocr` approval; see [OCR setup and limits](ocr-usage.md). Returns document ID/revision/counts. Reimporting the same absolute path replaces that catalog source revision. |
| `ks_v2_list` | `collection` | Disclose document IDs, labels, revisions and counts; `list` approval. Registered conditionally on runtime support; the current runtime implements it. |
| `ks_v2_search` | `collection`, `query`, optional `mode`, `limit`, `rerank` | Return an evidence bundle to the conversation/provider/session log; `search` approval, plus `embedding` for hybrid. No generated prose. |
| `ks_v2_index` | `collection` | Build/replace vectors for all collection text in the configured model space; separate `index` and outbound `embedding` approvals. Not automatic. |
| `ks_v2_export` | `collection`, `query`, `output`, optional `mode`, `rerank` | Retrieve up to 10 hits and export evidence; `export` approval covering body/captions/excerpts/images/provenance, plus `embedding` for hybrid. |
| `ks_v2_generate` | `collection`, `query`, `title`, `output`, optional `mode`, `limit`, `rerank` | Retrieve, send title and evidence bundle to the configured generation model, validate the returned document structure/references, export; `search`, `generate`, `export` approvals, plus `embedding` for hybrid. Title: 1–1024 characters. |
| `ks_v2_describe_image` | `path`, `prompt` | Send one validated PNG (raw bytes including metadata, at most 1 MiB) and prompt to the vision model; `vision` approval. Prompt: 1–8192 characters. Returns untrusted description, never indexes it as source evidence. |
| `ks_v2_document` | `collection`, `documentId` | Disclose original image IDs and locators for a captured document, without internal blob paths; `search` approval. |
| `ks_v2_enrich_image` | `collection`, `documentId`, `imageId`, `prompt` | Send the selected display PNG (original PNG or verified JPEG/WebP rendition) to the configured vision model, then save a source-bound **retrieval-only** description; separate `vision` and `enrich` approvals. Requires host vision revision. Returns untrusted model output. |
| `ks_v2_remove` | `collection`, `documentId` | Remove catalog document `doc_<64 lowercase hex characters>` after `remove` approval. Not secure erasure of blobs, originals, exports, backups or history. |

Tool JSON replies are capped at 40,000 bytes/1500 lines. Narrow the query/limit if truncated; no extra reply file is written.

## Storage, permissions and disclosure

- Collections live at `~/.pi/knowledge-studio/collections/<collection>/` (or under the configured `PI_KS_V2_DATA_DIR`), with SQLite catalog and content-addressed `blobs/`. The v2 base/collection directories and export base/output directories must be owned by the process user and **0700**. New directories are created safely; existing directories are not silently chmodded. If an owner-only error occurs, inspect the named directory and fix only that intended private directory (for example `chmod 700 <directory>`), not the entire workspace recursively.
- Source paths must be strictly inside cwd, without symlink traversal. One leading `@` is accepted. No recursive directory imports or URL fetching. Hidden path components and runtime/generated/vendor/build/cache/log/temp/credential-like names are refused, as is the export directory. These filename filters are **not secret detection**. Linked Markdown image paths undergo the same exclusions; conservative preflight can reject image-like syntax even in code fences.
- UI runs require trusted confirmation for each operation. Headless runs deny by default; host-set `PI_KS_V2_HEADLESS_GRANTS` is a comma-separated allowlist of `import,ocr,search,embedding,index,export,remove,list,generate,vision,enrich,rerank`. Grant only needed capabilities, not the whole list. For example, `PI_KS_V2_HEADLESS_GRANTS=search,list pi -e /path/to/extensions/v2.ts -p 'List demo and search it for scheduling'` allows metadata/excerpt disclosure from an existing collection without granting import, export or network embedding. Headless grants do not bypass confirmations when a UI is present.
- Search/list disclose source content or metadata to Pi's conversation model and logs even when retrieval is local. Generation sends the **entire selected evidence bundle and title**, including labels, locators, hashes and image metadata, but **no PNG bytes**, to its endpoint. Vision sends original PNG bytes including metadata, or a verified metadata-free PNG rendition for a captured JPEG/WebP. The latter's original JPEG/WebP bytes are not sent to vision. Embedding sends all text chunks during indexing, or the query during hybrid retrieval; no images.
- Export approval covers all selected body text, captions, supplementary excerpts, original image metadata/bytes, display renditions and source provenance. It is not a redaction toggle. Keep data/exports out of version control and review them before sharing.
- Gates are not a sandbox: other tools/extensions and same-user processes retain access. Mutation queuing and optimistic epoch checks are not cross-process transactions. Cancellation is cooperative and cannot immediately interrupt an in-flight HTTP request or local commit; inspect state before retrying. Partial indexing may require an explicit rerun. No hard OS memory quota, secure deletion, crash-durability guarantee or multi-tenant security is promised.

## Optional model configuration

Only **host environment** values are accepted, never endpoint/key overrides in tool arguments. V1 `PI_KNOWLEDGE_STUDIO_*` settings and `OPENAI_API_KEY` fallback do **not** configure this entry. V2 has no home/profile override or environment knobs for parser budgets.

All endpoints are **complete request URLs**, not base URLs: HTTPS, or HTTP only on `localhost`, `127.0.0.1` or `[::1]`. Embedded URL credentials, query strings and fragments are rejected by the entry; HTTP redirects are rejected by the adapter. Optional keys are sent as Bearer headers. Keep secrets out of prompts, committed scripts and source documents. HTTP calls default to a 30-second timeout, with 4 MiB request and 8 MiB response budgets. Generation and vision deadlines can be explicitly configured up to 180 seconds; there are no automatic retries. Grants do not waive these limits.

### Optional answer generation profile (host only)

`ks_v2_generate` can explicitly opt into the pinned llama.cpp request mapping:

```sh
export PI_KS_V2_GENERATE_PROTOCOL='llama.cpp'
export PI_KS_V2_GENERATE_MAX_TOKENS=2048
export PI_KS_V2_GENERATE_ENABLE_THINKING=false
export PI_KS_V2_GENERATE_REASONING_BUDGET_TOKENS=0
```

All three controls are optional; without them no new fields are sent. Controls
require the exact `llama.cpp` profile. `MAX_TOKENS` accepts canonical decimal
integers **1..32768**, `REASONING_BUDGET_TOKENS` **0..32768**, and
`ENABLE_THINKING` exactly **true/false** (lowercase). Empty, malformed, orphaned or
unsupported settings fail before any generation-tool egress, including hybrid or
rerank requests. Reload after host changes. No tool-argument override, endpoint
inference, server modification, retry or fallback exists. Generation approval
shows the profile/controls without secrets; existing separate approvals remain.
Vision and legacy generation are unaffected. Token limits do not guarantee valid
output or latency; truncated finishes still fail. See
[answer generation controls](answer-generation.md#optional-host-only-generation-controls)
for exact wire fields, immutable snapshots, pinned capability evidence and limits.
The Pi smoke script still isolates its environment and does not inherit these
controls; no new live inference was run for this feature.

### Embedding / hybrid retrieval

| Variable | Meaning |
| --- | --- |
| `PI_KS_V2_EMBED_ENDPOINT` | Required complete embedding URL, e.g. `http://127.0.0.1:8000/v1/embeddings`. |
| `PI_KS_V2_EMBED_KIND` | Required `openai` or `wemm`. |
| `PI_KS_V2_EMBED_PROVIDER` | Required provider identity label. |
| `PI_KS_V2_EMBED_MODEL` | Required model identity. |
| `PI_KS_V2_EMBED_REVISION` | Required revision identity; host-declared for OpenAI-compatible responses. |
| `PI_KS_V2_EMBED_DIMENSION` | Required integer dimension, 1–8192. |
| `PI_KS_V2_EMBED_QUERY_INSTRUCTION` | Optional prefix concatenated directly to queries; default empty. Include any desired separator. |
| `PI_KS_V2_EMBED_DOCUMENT_INSTRUCTION` | Optional prefix concatenated directly to chunks; default empty. |
| `PI_KS_V2_EMBED_API_KEY` | Optional Bearer credential; no fallback. |

Configure values matching your actual service **before starting Pi**, then call:

```text
ks_v2_index  {"collection":"demo"}
ks_v2_search {"collection":"demo","query":"your question","mode":"hybrid","limit":5}
```

OpenAI mode sends `{model,input}` and checks the response model, indices and vector dimensions. WeMM mode sends `{texts,dimension}` and requires matching `model_id`, `model_revision`, `dimension` and `embeddings`. An arbitrary embeddings endpoint is not guaranteed compatible.

Model-space identity includes provider, adapter kind, endpoint, model, revision, dimension and both instructions. Index the exact space first; missing coverage fails rather than silently falling back. Reindex after source changes or model-space changes. Runtime indexes chunks in batches of 16. Retrieval computes BM25-style lexical scores (Latin identifiers plus Han unigrams/bigrams) and exhaustive cosine similarity independently, keeps positive dense candidates, then fuses up to 50 candidates per list with RRF (`k=60`). Semantic-only hits are allowed. There is no ANN/vector server; ranking is local and in-memory over catalog snapshots. The runtime API accepts an optional `Reranker` as the fourth argument to `search`: it receives at most 30 detached candidate texts with opaque host IDs and must return a full permutation with finite scores. Only original host evidence is returned, never provider-supplied text. Optional `rerank: true` on search, export and generate uses the configured Cohere-style HTTP adapter, with a separate `rerank` approval for the query and up to 30 original candidate texts, including candidates not returned in the final result. The default is false. Responses must rank every supplied candidate exactly once; returned provider text is ignored. No rerank model service is bundled or automatically started, and real endpoint compatibility remains to be verified.

### Optional HTTP reranking

| Variables | Meaning |
| --- | --- |
| `PI_KS_V2_RERANK_ENDPOINT`, `PI_KS_V2_RERANK_MODEL`, `PI_KS_V2_RERANK_REVISION` | Complete Cohere-style rerank URL and host-declared model/revision identity. |
| `PI_KS_V2_RERANK_API_KEY` | Optional Bearer key. Excluded from model fingerprints. |
| `PI_KS_V2_RERANK_TIMEOUT_MS` | Optional integer 1–180000 ms; default 30000. |

The request contains `model`, `query`, `documents`, `top_n` and `return_documents: false`. Results require unique valid `index` values and finite `relevance_score` values covering the whole candidate list. This is not a universal rerank protocol.

### Grounded generation and vision

| Variables | Meaning |
| --- | --- |
| `PI_KS_V2_GENERATE_ENDPOINT`, `PI_KS_V2_GENERATE_MODEL` | Required for `ks_v2_generate`; complete OpenAI-compatible chat/completions URL and model. |
| `PI_KS_V2_GENERATE_API_KEY` | Optional generation Bearer key. |
| `PI_KS_V2_VISION_ENDPOINT`, `PI_KS_V2_VISION_MODEL` | Required for `ks_v2_describe_image`; complete chat/completions URL and image-capable model. |
| `PI_KS_V2_VISION_API_KEY` | Optional vision Bearer key. |
| `PI_KS_V2_VISION_REVISION` | Required host-declared model revision for persistent enrichment, not for standalone description. Part of derivation identity; not independently attested by the endpoint. |
| `PI_KS_V2_GENERATE_TIMEOUT_MS`, `PI_KS_V2_VISION_TIMEOUT_MS` | Optional integer deadline in milliseconds, 1–180000; default 30000. Set deliberately for slower inference; malformed values fail before egress. |

Generation requires support for strict `response_format: json_schema`; vision requires PNG data-URL image input. There are no default endpoints/models or automatic launches/downloads. Example calls after host configuration:

```text
ks_v2_generate {"collection":"demo","query":"scheduling","title":"Scheduling notes","output":"generated-notes"}
ks_v2_describe_image {"path":"diagram.png","prompt":"Describe the diagram and state uncertainty."}
```

Generated output is a restricted paragraph/figure document with evidence IDs, not arbitrary HTML. References and bundle membership are validated; **semantic support, source authenticity and factual correctness are not proven**. Generation has image metadata only and cannot truthfully claim to have viewed the figures. Vision descriptions are untrusted model output, not OCR or verified transcription, and are not merged into retrieval evidence. `ks_v2_enrich_image` can explicitly persist a description as a separate discovery hint bound to immutable source revision, image hash, model identity and effective prompt fingerprints. Hint matches resolve to the image's **original associated text elements**; generated descriptions never become source quotations. Images without linked text elements do not produce hint hits. Replacing/deleting a source excludes its old hints from active retrieval. Conflicting output for an identical derivation is rejected, not silently overwritten.

## Supported formats and explicit limits

- **TXT:** UTF-8 text, at most 20 MiB input and 1,000,000 text characters, no NUL. Chunks use 20-line windows with a 30,000-character cap per element.
- **Restricted Markdown** (`.md`, `.markdown`): same text limits; only inline `![caption](relative.png)` images (also `.jpg`, `.jpeg`, `.webp`) outside parsed code spans/fences are captured. No general CommonMark parser, HTML image support, reference-image syntax, remote/data URLs or image paths containing whitespace/parentheses. At most 100 image occurrences. Text remains source text, not executed/rendered source HTML.
- **PNG:** validated 8-bit, non-interlaced, non-palette grayscale/RGB/grayscale-alpha/RGBA PNGs, at most 4,000,000 pixels and 20 MiB each. Standalone images are searchable by filename, **not visual content**. Markdown and standalone PNG exports reuse validated original bytes including metadata. Retrieval associates images with text elements (up to five images per evidence bundle); it is not visual similarity search. Selected export image assets (originals and renditions together) total at most 50 MiB. GIF is not accepted.
- **JPEG/WebP:** originals retain exact bytes; a bounded `sharp` subprocess decodes single-frame images into separate metadata-free sRGB RGBA PNG display renditions (EXIF orientation is not applied). At most 20 MiB and 4,000,000 pixels per image; animation, type mismatches and decoder warnings reject. WebP validates RIFF length and excludes animation; JPEG checks boundary markers and decoder warnings but does not promise exhaustive validation of concatenated JPEG structure. Ten-second decoder deadline and bounded output are not a native-memory sandbox. Export re-decodes originals with the recorded recipe and verifies the rendition relationship, not just independent blob hashes. Original metadata is retained in the export and may be sensitive.
- **Digital PDF:** at most 20 MiB, 200 pages, 1,000,000 extracted text characters (100,000 per page); built-in sequential windows of at most **5 pages**, reopening the same original bytes in a fresh resource-isolated worker for each window (no external splitting or derivative PDFs). One import retains one original source hash/document ID with original physical page locators. Worker timeout is at most 30 seconds per window within a **120-second total capture deadline**, with abort propagation; heap stays 192 MiB and monitored RSS 512 MiB. Parent validates all window metadata/page order and enforces document-wide budgets before image writes/publication. Empty windows are allowed; wholly text-empty/scanned-only PDFs fail. Retrieval text uses deterministic page-local chunks targeting 800 UTF-16 characters, maximum 1,200, with about 100 overlap; paragraph/newline/sentence boundaries preferred, surrogate pairs preserved, no trimming or source-text gaps, at most 5,000 elements. All same-page chunks link to each supported image (not semantic association). No OCR, layout/table reconstruction or complete image extraction. Only supported decoded `paintImageXObject` bitmaps exposed by `unpdf.extractImages` are captured; inline images, masks, vectors and other unsupported images may be omitted. Limits include 100 images, 4,000,000 pixels per bitmap and 8,000,000 total image pixels. PDF images are re-encoded PNG **`decoded_embedded` derivatives, never original encoded image bytes**. Image/text links mean same page, not semantic association. Child-process isolation is not a sandbox or a hard OS memory quota.
- **Restricted DOCX:** main-body paragraphs and table-cell text with original embedded PNG/JPEG/WebP occurrences, using structural paragraph anchors rather than invented page numbers. Repeated placements preserve distinct occurrences. Image-only paragraphs retain images but have no text retrieval links. The image limits and optional decoder requirements above apply; unsupported drawings reject. No rendering, headers/footers, notes, pagination or formatting; fields, tracked revisions, text boxes, VML, alternate content and external relationships reject. Requires `python3`; stdin-only worker, no ZIP extraction/network, 30-second deadline, bounded ZIP/XML/text/image/output budgets. All parsed output and PNGs validate before image writes; failed imports can leave an unreferenced source blob, never a published catalog revision. Cropping, rotation and effects are not reproduced.
- **Restricted static HTML** (`.html`, `.htm`): Python stdlib structural parsing only, not a browser. Basic headings, paragraphs, simple lists and table cells are flattened into anchored text; local PNG/JPEG/static WebP occurrences retain original bytes and containing-block links. Image-only blocks have no fabricated text links. Tags must be explicitly balanced; unsupported tags/attributes, scripts/events, CSS/style/link, `srcset`, base URLs and active content reject. Head content is limited to UTF-8 charset metadata (even `<title>` is currently unsupported). Links are discarded and never followed. Local image paths undergo entity/percent normalization, source-policy checks and confined reads during actual ingestion as well as preflight. No remote/data URLs, traversal or symlink resources. Budgets: 20 MiB source, 1,000,000 text UTF-16 units, 5,000 blocks, 20,000 tags, 64 nesting levels, 100 image occurrences, 8 MiB worker output and 30-second parsing deadline. This deliberately rejects many ordinary styled web pages rather than pretending to reproduce their visibility or layout.
- **Opt-in full-document PDF OCR:** separate `ocr: true` import parameter and trusted `ocr` grant; host-configured pinned Linux x64 stack, no automatic installation/network. Every page is rendered/transcribed, including native pages. Original PDF, PNG page renders and exact TXT retained locally with explicitly unverified OCR provenance. Blank recognition rejects the entire import. At most 20 pages, 4M pixels/page, 8 MiB aggregate PNG bytes, 30 seconds/page and 120 seconds/OCR operation. Required page renders remain export verification assets, not necessarily illustrative figures. See [OCR usage](ocr-usage.md) for configuration, resource limits, authority and real-fixture evidence; this is not general recognition-quality proof.
- **Not supported:** browser-rendered/general HTML, EPUB/full office ingestion, recursive corpus import, automatic background indexing, automatic rerank service deployment, visual-vector retrieval, publication-quality layout, full production/multi-user deployment. Local SQLite persistence and evidence checks do not constitute the complete architecture envisioned in the redesign plans.

Native PDF recipe/storage compatibility and the single-file 50-page offline check are recorded in [Storage compatibility](STORAGE-COMPATIBILITY.md). The 200-page cap still rejects the 943-page full book; batching does not remove document-wide caps.

Storage upgrade: see [project layout and manual migration](storage-layout.md). Old roots are never moved automatically.

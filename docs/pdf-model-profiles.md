# PDF model profiles and shadow generations

This is an operational **PDF-only vertical slice**, not completion of the ordinary-collection model-profile plan. Native PDF capture and original images are reused; no OCR or new parser is introduced. Tests use synthetic PDFs/providers. No new real-book migration or model evaluation has been performed.

## Storage and identities

- Existing `native-pdf-job-v1` stores remain unchanged, including their exact SQLite schema. `PdfJobs.inspect()` adds metadata-only and individually budgeted vector visitors, not a schema migration.
- New store: `<cwd>/.pi/knowledge-studio-v2-pdf-generations/registry.sqlite`, version `pdf-generations-v1` with exact schema validation. Linux only; private owner-controlled root 0700 and files 0600. Unsafe modes, symlinks, hardlinks, unexpected schemas and oversized records fail closed. **No automatic chmod.**
- Each imported book has one UUID capture directory containing a validated private copy of the old PDF, database and lock file. Text/windows and original image blobs are shared across its generations, not recaptured per rebuild. The original legacy vector rows remain in that copy as well.
- Registry holds immutable profile revisions, selected default, per-book active generation plus monotonically increasing epoch, generation checkpoints and fenced run leases. Vectors are keyed by **generation ID and batch ordinal**, not merely by embedding-space identity.
- Exact vector identity is `[provider, model, revision, dimension, queryInstruction, documentInstruction]`. Profile HTTP identity includes `provider|kind|new URL(endpoint).href`. Imported ready indexes retain their original complete identity verbatim; it is not reconstructed or normalized.
- Adding an existing profile ID appends a revision. Selecting it changes only the default for future reindexes. Existing runs retain their snapshot and existing books retain their active index.

## Credentials and approval

Example `ks_v2_profile_add` input (all fields required):

```json
{
  "id": "embedding-local",
  "endpoint": "http://127.0.0.1:9000/v1/embeddings",
  "kind": "openai",
  "space": {
    "provider": "local-service",
    "model": "embedding-model",
    "revision": "pinned-model-revision",
    "dimension": 1024,
    "queryInstruction": "",
    "documentInstruction": ""
  },
  "credentialEnv": "PI_KS_PROFILE_EMBEDDING_KEY"
}
```

Set the referenced variable in the **trusted Pi host environment before extension registration**, or use `credentialEnv: null`. Only names matching `PI_KS_PROFILE_[A-Z][A-Z0-9_]{0,95}` are accepted. The extension uses its existing frozen environment snapshot; changing a host key requires reload. API-key/header fields are rejected. Resolved keys are never persisted or returned by profile/status tools. Profile keys must be nonempty visible ASCII (no whitespace/control/non-ASCII characters); invalid header credentials fail with a content-free error before Headers/Request construction. Profile transport failures are replaced with a fixed error without a cause for query, indexing and Pi tool errors. Do not put secrets in IDs, model names, instructions or URL paths: these are public profile metadata, not secret fields, and cannot be automatically classified as credentials.

HTTPS or loopback HTTP only; URL credentials, query strings and fragments are rejected. Existing HTTP adapter purpose restrictions, timeouts, response budgets and redirect policy remain in force. `openai` and `wemm` are the supported embedding protocols; vision/generation/rerank profiles are out of scope.

Existing UI confirmation/headless `PI_KS_V2_HEADLESS_GRANTS` policy applies: `list`, `import`, `index`, `search`, `embedding`. Creating a shadow requires index approval; every explicit resume/retry requires fresh index plus text-egress approval. Query embedding requires separate approval. Profiles are not permission grants. No automatic startup/resume/network operations are introduced.

## Concrete workflow and Pi API

1. `ks_v2_profile_list {}`; `ks_v2_profile_add {...}`; `ks_v2_profile_select {"id":"embedding-local","revision":1}`. `/ks-v2-profiles` provides the interactive revision-selection menu. Add/list also remain structured tools rather than a custom editor.
2. Stop legacy writers. Explicitly call `ks_v2_pdf_migrate {"legacyRoot":"relative/path/under/cwd","bookId":"book_<sha256>"}`. The source must be a fully parsed or ready v1 job. New PDFs can first use existing `ks_v2_pdf_start` without embedding, then import their parsed capture.
3. Migration copies source files read-only into private staging, verifies source/window/image/vector bindings and exact schema, then registers the copy. Legacy 0755/0644 roots/files are accepted **only on this copy-import path**, without modifying originals. Live/recovery WAL/journal sidecars are refused. An already imported book is refused. A ready index is immediately registered active without any embedding; a parsed capture has no active index until a new generation is ready and activated.
4. `ks_v2_pdf_reindex {"bookId":"..."}` creates a paused shadow using the selected revision. Record its returned `id`.
5. `ks_v2_pdf_generation_resume {"generationId":"..."}` runs serial document batches of at most four. Progress is durably committed after each batch. Provider synchronous entry occurs under the short shared control transaction; the response is awaited only after releasing it, so another tool/process can inspect, pause, cancel or search the old index while HTTP is blocked.
6. `ks_v2_pdf_generation_status {"bookId":"..."}` returns active ID/epoch and all states/checkpoints. `ks_v2_pdf_generation_pause` fences the in-flight response and allows explicit resume. `ks_v2_pdf_generation_cancel` is terminal; create a new reindex to retry a cancelled generation. Neither can stop a ready/active generation. Transport messages/credentials are not stored as failure diagnostics.
7. Complete vectors, source and bindings are validated before state becomes `ready`. This **does not activate** the shadow. Call `ks_v2_pdf_generation_activate {"bookId":"...","generationId":"...","expectedActive":"old-id-or-null","expectedEpoch":1}` with the status values (use JSON `null`, not a string, if there is no old active ID). Compare-and-swap checks both active ID and epoch, preventing stale/ABA switches.
8. `ks_v2_pdf_generation_search {"bookId":"...","query":"...","mode":"lexical","limit":5}` searches the pinned active generation. `hybrid` resolves the active generation's profile, never the selected default. Imported legacy generations initially have no credential-profile association. Explicitly call `ks_v2_pdf_generation_associate {"generationId":"...","profileId":"embedding-local","profileRevision":1}` with separate index approval to freeze that trusted stored revision onto the ready import. The computed full space must match exactly (provider including protocol kind and normalized endpoint, model, revision, dimension, both prefixes); mismatches reject. This does not rewrite vectors, change the active pointer or authorize egress. Hybrid then uses this frozen association before and during a different-profile shadow build; every query still needs separate embedding approval. No endpoint or credential is guessed. A race changing identity during tool approval fails closed rather than querying a different model.
9. `ks_v2_pdf_generation_rollback` takes exactly the activation arguments, with a retained ready generation as target and the current active ID/epoch. No vectors or captures are deleted. The older `ks_v2_pdf_search/status/resume` tools still address only the original v1 store, not this active-generation pointer.

Application API lives in `src/application/pdf-generation-store.ts`: `PdfGenerations.profiles/addProfile/selectProfile/selectedProfile/importLegacy/reindex/resume/stop/status/generationSnapshot/associateProfile/activate/search`, plus `profileSpace`, `profileProvider`, `embeddingIdentity`. `activate` is also the rollback primitive.

## Recovery, concurrency and limits

- Synchronous SQLite control/checkpoint transactions use DELETE journaling, FULL sync and immediate writer acquisition. They include synchronous provider entry but never await HTTP. A stop committed before dispatch authorization prevents provider entry; a stop after entry fences its response. Pending rejection is consumed even if the dispatch transaction commit fails. Conflicting local writers can fail with SQLite busy; caller explicitly retries. There is no hidden retry loop.
- Crash leases last 60 seconds; after expiry an explicit resume takes over. An old response cannot commit after lease expiry, pause, cancel or takeover. Committed batches are validated and skipped. Explicit pause can fence a crashed lease immediately. Cancellation fences persistence, **does not interrupt an already dispatched HTTP request**, and cannot undo provider cost.
- In-process validation/search still scans capture metadata and can block the event loop during synchronous SQLite work. This is not a streaming ANN index or constant-time status guarantee during local validation. Existing capture validation also hashes source/images.
- Host `PI_KS_V2_PDF_MAX_INPUT_BYTES` and `PI_KS_V2_PDF_MAX_STORAGE_BYTES` are inherited from v1 (defaults 512 MiB input, 4 GiB storage). Import must match the recorded v1 limits exactly. The generation registry's DB is capped at one quarter of configured storage; its journal can temporarily add another DB-sized allocation. Each capture is separately bounded by v1 quotas. **There is no aggregate directory-wide disk reservation** across all imported books, staging or retained generations.
- Registry JSON max 1 MiB; at most 256 profile revisions, 128 books and 1024 generations. Each vector batch JSON max 2 MiB, dimensions 1–8192. Capture metadata working set max 64 MiB serialized; ready-import batches share a 64 MiB budget charged before each JSON fetch/parse: SQL byte length plus numeric backing estimate (8 bytes/value) plus copied element metadata. Vectors are streamed individually into the bounded retained import set; metadata-only windows never read vector payloads. Metadata inspection alone does not authenticate vectors; import and generation batch readers validate them separately. Actual JS heap includes additional array/engine overhead; these are accounting budgets, not a total process RSS cap. Larger inputs fail explicitly, not an arbitrary/unlimited support claim. No new fixed page cap.
- Failed ordinary imports clean staging. A process/power crash between capture rename and registry publication can leave an unregistered UUID directory; no automatic destructive GC is provided. Retained generation/capture cleanup, aggregate quotas and fully streaming registry publication remain future work.
- Import requires a quiescent legacy writer; before/after copy checks and full validation detect inconsistent copies, but this is not a live SQLite backup protocol. Registry initialization/control contention can fail closed; inspect/retry explicitly. Schema and singleton initialization share an immediate transaction. Retry recovers only a no-object DB or the exact known schema with both tables empty; schema-only interrupted older initialization is recoverable, but populated orphan vectors or foreign schemas reject. Owner-controlled storage is assumed: path safety is not a defense against a malicious process running as the same OS user and rewriting files between operations.
- No ordinary collection runtime integration, automatic legacy credential association, full profile-management editor, physical HTTP abort, migration of partial `indexing` jobs, or production durability/load certification is claimed.

## Verification

Synthetic source-capture tests cover legacy identity/image preservation, 0755/0644 byte-preserving import, same-space isolation, A-search/status/cancel while B is blocked, concurrent resume rejection, pause fencing, failure checkpoints, SIGKILL recovery, immutable profile revisions, provider drift, atomic CAS/rollback, corrupt schema/registry/vector bindings, symlinks, quotas and egress denial. Pi registration/tool tests cover new tools and denied resume without outbound calls. See `tests/pdf-generations.test.ts` and `tests/v2-extension.test.ts`.

Latest local run for this slice: `npm run check` passed;
`node --experimental-strip-types --test tests/pdf-generations.test.ts tests/pdf-jobs.test.ts tests/v2-extension.test.ts`
passed **49/49**; `npm test` reported **256 tests, 246 passed, 10 skipped, 0 failed**.
Skipped coverage is existing optional/environment-dependent coverage, not a pass.
Final full log: `/tmp/pdf-fixes-full-final.log` (also passed in `/tmp/pdf-fixes-full-retry.log`); scoped log: `/tmp/pdf-fixes-scoped.log`. Initial parallel full run (`/tmp/pdf-fixes-full.log`) failed: 250 reported tests, 236 passed, four failures, ten skips, including loopback EADDRINUSE and three file-level failures. Unchanged rerun passed; this is an environment/concurrency instability observation, not a claim that the first run passed.
No production endpoints, private knowledge bases or actual book stores were used for this slice.

Review regressions additionally cover predispatch stop and shared SQLite entry lock, postdispatch fencing, failed-COMMIT pending rejection, malformed synthetic credential Request repro and transport causes through tools, metadata-only inspection and many-batch preallocation rejection, concurrent initialization and SIGKILL file-created/schema-before-row faults, whitespace lexical misses, and explicit exact-space legacy profile association. These offline synthetic checks do not certify whole-product completion or power-loss durability.

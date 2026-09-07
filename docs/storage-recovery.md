# Storage and offline recovery

Studio v2 currently targets a private, single-user local collection directory. It does not promise power-loss-safe transactions spanning SQLite and filesystem blobs, automatic garbage collection, live backups, or secure erasure.

## Logical deletion and retention

Removing a document removes it from active search and advances the catalog epoch. Inactive immutable revisions, vectors, hints and content-addressed source/image blobs remain. Failed or conflicting imports may also leave unreferenced blobs; interrupted processes may leave staging files. Retention uses disk space and is not secure deletion.

Do not manually delete blobs based only on active search results. An inactive revision may reference the same object, and concurrent importers may share a hash. Do not delete all blobs when an import fails. There is currently no supported automatic GC operation. Monitor available disk space and stop importing before exhausting it.

## Offline collection backup

Portable illustrated exports are selected reading packages, **not collection backups**. A recursive copy while imports or other writers run may combine an old blob directory with a new SQLite catalog, or omit SQLite transaction state.

1. Stop every Pi session, script and background job using the collection. Wait for all jobs and database connections to finish. Do not stop unrelated remote model services.
2. Record the Studio package version and optional decoder version. Keep compatible decoder packages: JPEG/WebP revalidation is recipe-bound.
3. Copy the **entire collection directory**, including `catalog.sqlite`, all blobs and any SQLite sidecar files that remain. Do not copy only the database, or select files while other jobs reopen it. Keep originals until restoration is verified.
4. Preserve private ownership and permissions. The restored collection root must be owned by the current user and private on POSIX; database files must also remain private. Store backups securely: they contain original documents, images and potentially metadata.
5. Restore to a **separate** private directory, never over a live collection. Use the same supported Studio version initially. Do not edit schema-version markers to force an older executable to open a newer catalog.
6. Run the offline verifier below against the restored copy before opening it through Studio. It checks active and inactive retained history together. Respect its schema/sidecar preconditions and investigate failures or incomplete checks without modifying the original backup. After offline verification, separately test representative queries and image exports; those runtime checks are not part of the read-only audit.
7. Keep both backup and original until acceptance succeeds. Resume writers only after the copy is complete. Test restoration periodically.

`tests/catalog-transactions.test.ts` includes an offline whole-directory copy and restart test: it closes all collection connections, copies the collection, deletes the original inputs/storage, reopens the copy, and verifies source and image hashes. This is a small recovery regression—not proof of arbitrary live-copy consistency or power-loss durability.

## Failure guarantees and limits

Catalog publication and removal are transactional: an injected failure must roll back the active mapping and epoch. Concurrent operations with a stale epoch fail rather than publishing stale data. Source/image CAS publication is atomically visible during normal process operation but not synced as a cross-store power-loss commit.

Filesystem publication of a portable document is atomic staging/rename; it is not a catalog-coordinated deletion barrier. An export whose snapshot was approved before a later deletion may still finish. Deletion is not retroactive revocation of already shared output.

Parser subprocess time, input/output and pixel budgets reduce risk, but are not a complete OS sandbox. Use trusted local ownership and isolate untrusted documents in a stronger container/OS boundary for higher-assurance deployments.

## Gate5: host-operated offline retained-collection verifier

On **Linux, Node >=22.19**, with all collection users stopped, run from the Studio checkout:

```sh
node --experimental-strip-types scripts/verify-collection.mjs --offline --root /absolute/private/restored-collection
```

`--root` names the **collection directory**, not the source-document directory or a portable export. No elevated/root user is required: run as the collection's owner. `--offline` is an explicit operator assertion that **every writer is stopped**; the verifier cannot establish that assertion. No new Pi tools, model permissions, network calls, services, GC or migration are involved.

The verifier opens the existing database with `DatabaseSync(..., { readOnly: true })`, a query-only read transaction, and never uses `SqliteCatalog.use`. The only schema initialization is in a separate `:memory:` reference database. It accepts **schema v2 with the catalog’s shared read-only structural/token validator**: conservative token-equivalent formatting, keyword case and quoted identifiers are accepted; unknown structures or semantics and older/future versions are refused. Version, schema-size and row budgets remain verifier-specific. It never invokes the migrating initializer on the inspected database; production initialization/migration behavior is unchanged. SQLite quick-check and foreign-key checks are followed by retained-row checks.

**Conservative SQLite prerequisite:** this implementation refuses *any* `catalog.sqlite-wal`, `-shm`, or `-journal` artifact, even an empty one, and refuses WAL-mode database headers. It does not recover, checkpoint or remove sidecars. Retain the full original backup including sidecars; if recovery/checkpointing is needed, use a separately authorized compatible SQLite workflow on a disposable copy, then audit the closed rollback-mode result. Never delete sidecars to make the check pass. A failed preflight means **not verified**, not necessarily corrupt.

### Checks and result semantics

- Every retained revision, **active and inactive**: capture revision digest, catalog/payload identity, locators, image/element links and source hash bytes.
- Original image bytes and retained rendition bytes: SHA-256 and the existing PNG validator. JPEG/WebP rendition association is re-decoded with the existing bounded local image worker, requiring the recorded sharp/libvips recipe to match. Missing/incompatible decoder or recipe fails the check rather than certifying it; no automatic installation occurs.
- OCR: existing provenance/recipe/source/page bindings, every render's hash/PNG/geometry, every transcript's hash/UTF-8/slices, and complete transcript coverage. This validates synthetic or real *stored contracts*, not recognition accuracy, PDF extraction correctness or reproducibility of the OCR stack.
- Retained hints: identity, description hash and derivation ID, original-image/source/revision references; descriptions remain retrieval-only.
- Retained vectors: revision/element references, hash-shaped space keys, finite nonzero arrays, dimensions 1..8192 and consistent dimensions across each stored space. **v2 stores only an opaque space hash**, not provider/model/instructions or declared dimension. Those checks and embedding completeness cannot be reconstructed; any collection containing vectors returns `incomplete` unless another error makes it `failed`.
- Informational counts of unreferenced hash-named blobs, `.staging-*` files and other regular files. Orphan contents are **not** read/hash-certified. Nothing is deleted or repaired. Unknown directories and unsafe artifacts are rejected, not recursively followed.

Output is bounded JSON with fixed issue codes, counts and limitations; no source text, hints, vectors, filenames, model configuration, raw errors or secrets. `passed`/exit **0** means the stated retained-integrity checks completed, not authenticity or a complete gate5/product certification. `incomplete`/exit **2** means metadata cannot support requested checks or an audit budget was exhausted. Budget exhaustion immediately stops the audit and adds the fixed `verification-budget-exhausted` code, never a corruption code for the interrupted check. If earlier checks found errors, those findings remain, but the overall budget-stopped result is `incomplete`. `failed`/exit **1** means a safety, contract, decoder or integrity check failed; argument errors exit **2**. Counts describe completed work and can be partial after failure; `blobs` counts distinct referenced hash identifiers, not a separate certification count.

### Safety and bounds

Missing roots/files are never created. Linux descriptor-relative directory traversal rejects symlink ancestors; files must be regular, private (no group/other mode bits), owned by the invoking UID and not multiply hard-linked. Root and blob directories must be private and owned. Unsafe blob/artifact symlinks, permissions and types fail closed without chmod. Other platforms are refused because equivalent guarantees are not implemented. These checks assume quiescence; they do **not** protect against concurrent same-UID path replacement or establish same-user tamper authenticity.

Fixed limits: 256 MiB database; 100 schema objects / 100,000 aggregate schema SQL/name bytes; 10,000 total catalog rows; 32 MiB aggregate JSON payload bytes; 8,000,000 capture / 120,000 hint / 1,000,000 vector bytes per row; 128-byte stored identifiers; 20,000 aggregate capture elements/images; 20 MiB per blob; 512 MiB cumulative requested referenced-blob read budget (each request is charged its file size before reading; repeat hashes count again, including source/image/display/OCR rechecks; not unique retained bytes; no result caching); 20,000 inventory entries; 100 issue occurrences before immediate termination (plus one terminal budget code). Existing capture/OCR/PNG/decoder limits also apply. Exceeding an explicit verifier resource limit stops with `incomplete`/`verification-budget-exhausted`; invalid stored contracts rejected by existing capture/OCR/PNG/decoder validators remain validation failures. No further artifact checks or inventory run after exhaustion; this is deliberately not an unbounded large-collection validator. It has no overall wall-clock/OS memory sandbox guarantee. Filesystem access time may change from reads; file contents, permissions, mtime and directory entries are not intentionally changed.

`tests/verify-collection.test.ts` covers offline restored active/inactive history, missing/corrupt inactive blobs, future/legacy schemas, unsafe paths/modes and sidecars, malformed/oversized records, row budgets, token-equivalent v2 schema/no-write regression, repeated-hash cumulative read exhaustion and cumulative capture-item exhaustion, retained hints/vectors, synthetic OCR contracts, real-codec JPEG/WebP rendition verification, CLI behavior and recursive before/after byte/name/ownership/mode/mtime comparisons. It does not simulate power loss, hostile concurrent writers or certify real OCR recognition. Keep the original and backup until operational restore acceptance is complete.

# Opt-in local full-document PDF OCR

## Authority contract

`ks_v2_import({collection, path, ocr: true})` requires **both** ordinary import approval and a separate trusted `ocr` approval. In headless operation both `import,ocr` must be in the host's `PI_KS_V2_HEADLESS_GRANTS`. A tool argument cannot select executable paths, config files, language data, environment, argv, or grant itself permission.

The host sets `PI_KS_V2_OCR_CONFIG` to an absolute JSON configuration path **before extension registration**. Registration snapshots this string but does not read the config, execute children, install anything, or access the stack. Only an approved OCR operation loads and hashes the configuration's files. The direct trusted-library equivalent is `runtime.ingest(root, path, {ocr: {approved: true, configPath}, signal})`; library callers, unlike model tool arguments, are authority holders.

`ocr` omitted/false retains the existing native PDF implementation and revision recipe. Native mode is **not** full-page coverage: mixed scans and native page-number overlays can be missed. OCR mode deliberately renders **every page**, even native-only pages, rather than pretending to classify mixed content. Empty/whitespace recognition is an actionable whole-import failure, including genuinely blank pages. No silent native-only fallback, model fallback, installation, or network access.

## Configure a previously verified external stack

The host-only helper is intentionally under `src/adapters/parsing/ocr-configure.mjs` rather than the separately maintained `scripts/` directory:

```sh
# Existing, trusted extracted Debian-compatible Linux x64 stack. No download here.
mkdir -m 700 /your/private/ocr-temp
node src/adapters/parsing/ocr-configure.mjs \
  /your/verified/extracted-root /your/private/ocr.json /your/private/ocr-temp
# Inspect the generated file and its hashes before approving operations.
export PI_KS_V2_OCR_CONFIG=/your/private/ocr.json
```

No production path defaults to `/tmp/studio-ocr-prereqs`. The helper accepts a relocated trusted root and uses **host `/usr/bin/ldd` only during explicit host configuration**, never from the extension or on a model-specified binary. Do not run it against untrusted executables. It creates a new owner-only config without overwriting. It pins resolved Poppler/Tesseract binaries, their loader/dependency closure (including compatible host libraries), `eng`/`chi_sim` traineddata, and the extracted WenQuanYi fallback font. Both native PDF rendering and Chinese fallback fonts matter: missing font setup can produce an empty native-page render. The helper does not validate repository signatures; prerequisite acquisition/authentication remains a host responsibility.

Config shape (illustrative, **not** executable placeholder hashes):

```json
{
  "version": 1,
  "platform": "linux-x64",
  "tempRoot": "/owner-only/ocr-temp",
  "files": [
    {"name": "pdftoppm", "path": "/verified/usr/bin/pdftoppm", "sha256": "<actual SHA-256>"},
    {"name": "pdfinfo", "path": "/verified/usr/bin/pdfinfo", "sha256": "<actual SHA-256>"},
    {"name": "tesseract", "path": "/verified/usr/bin/tesseract", "sha256": "<actual SHA-256>"},
    {"name": "loader", "path": "/verified/loader", "sha256": "<actual SHA-256>"}
  ]
}
```

Use the helper for the **complete** list, not this abbreviated example. Changing even one pinned byte fails closed. Baseline verified here: Poppler 22.12.0, Tesseract 5.3.0, Debian eng/chi_sim 4.1 data. Pins establish reproducibility, not currency, security certification, or recognition correctness. Refresh a stack explicitly after reviewing security updates.

## Execution and budgets

- Linux x64 only; current-user-owned regular config/files, no group/other writes; no symlink traversal when reading pinned files. Temp root must be owned and mode 0700.
- Config ≤128 KiB; ≤150 pinned files; ≤50 MiB/file, ≤256 MiB total loaded stack. Files are hashed and copied into a private operation directory before execution; execution does not reopen the original executable/library paths.
- Private copied dynamic loader, `--inhibit-cache --library-path`, and dependency-list preflight reject unpinned resolved dependencies before writing private PDF input. Private font config points only to copied fallback font/stack. The copied stack still depends on the Linux kernel and may use OS facilities; this is not a self-contained OS image.
- Minimal environment: fixed locale, private HOME/TMPDIR/font config, OMP thread cap; no inherited PATH, preload, TESSDATA_PREFIX or caller environment. Fixed argument arrays, `shell:false`, sequential children.
- PDF ≤20 MiB; **1–20 pages**. All pages must yield nonempty TXT. No TSV/boxes/confidence is declared or produced; the exact UTF-8 TXT bytes **are retained** in CAS.
- Render at ≤200 DPI, longest edge ≤2000, ≤4,000,000 pixels/page. Poppler's `-scale-to` overrides DPI: the adapter uses `min(2000, floor(longest-page-points * 200 / 72))` so small pages are not inadvertently upscaled past 200 DPI. Geometry beyond 1,000,000 points is rejected.
- PNG ≤8 MiB/page **and ≤8 MiB aggregate PNG bytes**. This is a byte budget, not an 8-million aggregate pixel budget; aggregate pixels are at most 80 million across 20 sequential pages. Existing 4-million per-image validation is unchanged.
- TXT ≤400,000 bytes and ≤100,000 UTF-16 units/page; index chunks ≤30,000 UTF-16 units. Whole capture keeps the existing ≤2-million text-unit and ≤70-MiB staging ceilings.
- 30-second render/recognition/geometry budget per page, 120-second OCR operation deadline including stack setup; outer capture deadline 130 seconds. Deadlines are checked cooperatively between bounded file operations and actively enforced during children. Filesystem stalls cannot be forcibly interrupted by these timers.
- Combined stdout/stderr ≤16 KiB; output-size polling every 50 ms plus strict final bounded reads. Cancellation/deadline kills the detached process group; cleanup follows child close. Private temp tree is removed on success/failure.

**Not an OS sandbox or hard disk/RSS/process quota.** A child can overshoot polling limits between checks; font caches/runtime data and kernel behavior are not attested by a model. Same-user processes remain trusted. Use an independently approved OS resource limiter/container for hostile PDFs. Cancellation is cooperative during local blob writes and has the existing check-to-catalog-commit race. Failure before CAS flush publishes no blobs/catalog; interruption during flush can leave unreferenced blobs, never a successfully published partial OCR document.

## Provenance, retrieval, export and generation

OCR uses parser variant `local-pdf-full-ocr-v1`; native captures do not gain new default fields or changed revision hashes. Every transcript chunk and page image binds original PDF hash, 1-based page/page count, rendered PNG hash, full TXT hash, actual geometry, stack fingerprint and fixed recipe fingerprint. Chunk offsets are JS UTF-16 units. Revision hashing covers the complete element/image objects, including full consecutive page coverage. The stack fingerprint hashes sorted `[logical file name, actual pinned SHA-256]` pairs; it contains no filesystem paths. Recipe fingerprint identifies the renderer scaling recipe, eng+chi_sim/OEM1/PSM6 and full-document mode. Executable hashes identify versions more strongly than their self-reported strings; no public path-bearing stack manifest is exported.

Text is permanently marked **“Unverified OCR transcript—not an exact original quotation.”** Hash verification proves retained-byte integrity, never recognition accuracy. Page images have `originKind: page_render`, not `embedded_original`. The original PDF is retained locally but **never automatically exported**, since full-document disclosure requires separate authority.

Search retains OCR provenance and verifies TXT/render blobs. Required OCR renders bypass the normal five optional-image cap (bounded by at most ten selected text hits), rather than silently losing their page binding. Model/rerank/embedding grants still independently govern egress of transcripts just as native captured text. Grounded generation receives provenance and an explicit uncertainty/no-original-quotation instruction, not image bytes. Host export adds warnings regardless of model compliance; reference checks do not prove semantic support.

Export includes required page renders even when a generator omits figure blocks, requires image permission, and verifies retained TXT/render hashes. Supplementary OCR excerpts use labeled transcript sections rather than blockquotes. `excerpts:false` retains provenance and warnings but does not redact the approved document body. Original PDF and full TXT blobs are not silently added to the package. The legacy rerank consent phrase “ORIGINAL candidate texts” is immediately qualified as stored capture values including **UNVERIFIED OCR**, not verified original quotations; this preserves existing UI regression expectations without attributing OCR to an original quote.

## Reproducible checks

Checked-in fixtures are authored public synthetic PDFs, not private data. `tests/fixtures/ocr/generate.py` regenerates them offline using host Pillow/ReportLab and an explicitly supplied Chinese font. No runtime packages are vendored. The fixtures cover image-only English/Chinese, native text, alternating native/scan, a scan with native overlay, and a blank second page.

```sh
PI_KS_OCR_TEST_REQUIRED=1 PI_KS_OCR_TEST_CONFIG=/your/private/ocr.json \
  node --experimental-strip-types --test tests/ocr-capture.test.ts tests/ocr-extension.test.ts
npx tsc --noEmit
```

Explicit required mode **fails**, not skips, if config is absent. Ordinary offline tests do not require OCR installation. Actual pinned-stack tests passed here at **1414×2000**; English and Chinese match after whitespace removal. This validates the authored clean fixture only, not noisy scans, handwriting, columns, complex layout, or OCR accuracy in general. Generator transport assertions use a mock HTTP response to inspect the real evidence payload; no external model-quality claim is made.

Known test gaps: exhaustive hostile ELF/PDF fuzzing, resource-exhaustion/timeout matrices, OS hard isolation, and production recognition-quality benchmarks. These are not implied by the integration tests.

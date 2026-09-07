# OCR prerequisite feasibility — real bilingual recognition passed

Date: 2026-09-06. Scope: isolated prerequisite staging only. No Studio source, package manifest, lockfile, existing progress document, system package installation, remote machine, or service was changed. All runtime artifacts are under `/tmp/studio-ocr-prereqs`.

## Result

The earlier network blocker is **not current for this environment**: HTTPS Debian downloads worked. A real Poppler → Tesseract test passed using a synthetic **image-only PDF**, not PDF text extraction, vision captioning, or mocked OCR.

- Fixture: one white 2480 × 3508 RGB page with two black 78-pixel WenQuanYi Zen Hei text lines. PNG embedded as a full-page image into a PDF; no text objects used for the phrases.
- English input: `Knowledge retrieval preserves original images.`
- Chinese input: `知识检索保留原始图片`
- `pdftotext` output is whitespace only, asserted before OCR.
- Poppler `pdftoppm -f 1 -singlefile -r 300 -png` rendered the PDF.
- Tesseract `-l eng+chi_sim --oem 1 --psm 6` recognized that rendered PNG and emitted TXT plus TSV word boxes/confidences.
- Both phrases match exactly **after removing whitespace**. Raw OCR inserts spaces in Chinese; this is not a byte-exact transcription claim.

Actual raw output:

```text
Knowledge retrieval preserves original images.
知识 检索 保留 原始 图 片
```

First run: PDF text-layer check 0.357 s; rendering 0.395 s; OCR 1.227 s. Full commands and timings: `/tmp/studio-ocr-prereqs/test-output/result.json`. This is one clean authored page, not a noisy-scan/handwriting/layout benchmark or proof of production readiness.

## Isolated stack and trust

Host: Debian 12 amd64, system Python 3.11 and existing glibc/base libraries. Extracted Debian packages, not a self-contained portable runtime:

| Component | Exact Debian version |
| --- | --- |
| Poppler utils / libpoppler126 | `22.12.0-2+deb12u2` |
| Tesseract / libtesseract5 | `5.3.0-2` |
| Leptonica | `1.82.0-3+b3` |
| eng / chi_sim / osd data | `1:4.1.0-2` |
| WenQuanYi Zen Hei | `0.9.45-8` |
| Pillow (synthetic fixture only) | `9.4.0-1.1+deb12u1` |
| ReportLab (synthetic fixture only) | `3.6.12-1+deb12u1` |

These are established maintained renderer/OCR projects packaged by Debian; version pins are a reproducibility baseline, **not a latest-version or security-audit claim**. Only bookworm main was used, not a full security/LTS update review. Review current supported security versions before deployment.

APT fetched authenticated bookworm metadata over verified HTTPS into temporary directories. `gpgv` separately verified the retained InRelease with `/usr/share/keyrings/debian-archive-keyring.gpg`: good Debian bookworm archive, trixie archive, and bookworm release signatures. SHA-256 values came from that authenticated Packages index; all 59 archive bytes were checked against them **before extraction**. `dpkg-deb -x` does not execute maintainer scripts or register installed packages. No global `apt install`, TLS bypass, pip/npm change, credential dump, or private-document upload occurred.

Language file SHA-256:

```text
7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2  eng.traineddata
a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730  chi_sim.traineddata
```

## Bounded investigation and network attempts

1. Local inventory: no Tesseract, Poppler CLI, MuPDF CLI, Chinese fonts, traineddata, Pillow, PyMuPDF, ReportLab, or pip found in the checked paths/imports; APT lists/cache empty. This is a bounded inventory, not a whole-filesystem absence proof.
2. Two HTTPS HEAD requests to `https://deb.debian.org/debian/dists/bookworm/Release`, each connect timeout 5 s / total 12 s: configured proxy and direct `--noproxy '*'` both succeeded. Only proxy host presence was inspected, not credentials/environment dumps.
3. One isolated `apt-get update`, `timeout 28`, retries zero, HTTPS timeout 10 s: authenticated InRelease and 8.79 MB Packages fetched in 26 s.
4. One isolated `apt-get --download-only --no-install-recommends`, `timeout 28`: deadline stopped the sequential batch during the font download; eight archives completed. This was a wall-clock budget stop, **not TLS failure**. Partial file remained in temporary cache.
5. One parallel curl batch: 51 missing archives, each connect timeout 5 s / total 22 s, no retry, outer tool budget 30 s. All succeeded directly with default TLS verification. Maximum 59 threads in helper; cached files skip network. Total completed set: 59 archives / approximately 42.7 MB. No further network attempts needed.

Logs: `apt-update.log`, `download-1.log`, `download-2.log`, `signature.log`, `test.log` under the staging directory. Previous `ECONNRESET` / `SSL_ERROR_SYSCALL` are historical progress notes, not errors reproduced here. No Python-wheel or npm fallback was needed after the Debian route succeeded.

## Reproduce from retained artifacts

The staging tree contains:

- `packages.lock.json`: all 59 exact package versions, URLs, sizes, authenticated SHA-256 pins.
- `cache/archives/*.deb`: verified package downloads; `root/`: extracted runtime.
- `apt.conf`, `sources.list`, `lists/`: isolated configuration and signed repository metadata.
- `download.py`: bounded direct HTTPS downloader, cached-file and downloaded-byte SHA-256 checks, no retries.
- `replay.sh`: download missing locked archives, verify, extract, run synthetic test.
- `test-ocr.py`: deterministic raster fixture/PDF generation, empty text-layer assertion, actual renderer/OCR commands, phrase checks.
- `test-output/`: `source.png`, `scanned.pdf`, `rendered.png`, `text-layer.txt`, `recognized.txt`, `recognized.tsv`, `result.json`.
- `SHA256SUMS`: staging scripts, metadata, lock, fixture, and result hashes. Timings make `result.json` change on rerun.

Check original handoff artifacts **before rerunning**:

```sh
cd /tmp/studio-ocr-prereqs
sha256sum -c SHA256SUMS
# SHA256 of packages.lock.json:
# be306971f05d6d45214018b682e965209a7be9d7431abfbae9106c8a032da72c
```

Repeat the actual test offline using the already extracted stack:

```sh
cd /tmp/studio-ocr-prereqs
export LD_LIBRARY_PATH="$PWD/root/usr/lib/x86_64-linux-gnu"
export PYTHONPATH="$PWD/root/usr/lib/python3/dist-packages"
export PYTHONDONTWRITEBYTECODE=1 OMP_THREAD_LIMIT=2
timeout 28 python3 test-ocr.py
```

To re-extract verified cached dependencies, `timeout 28 sh /tmp/studio-ocr-prereqs/replay.sh` is sufficient for this cached environment. On a cold download, run its download/extraction/test phases separately with 30-second invocation limits rather than extending one unbounded call. Scripts assume this exact staging path and compatible Debian amd64 host. `/tmp` is ephemeral: preserve the entire staging directory for handoff; this document alone does not vendor dependencies. Debian pool URLs can disappear after package supersession: do not silently replace pinned versions; retain archives or deliberately refresh verified pins.

## Handoff boundary

Prerequisite feasibility is unblocked. **No OCR integration was implemented.** Main implementation owner decides design and transcription provenance. Keep OCR text separate from original quotations; bind it to source revision, page, rendered-image hash, renderer recipe, OCR engine/data hashes, language/PSM/OEM and available boxes/confidence. Preserve source PDF and page imagery. Confidence is not truth, and OCR text should not be presented as verified original text.

Before production ingestion, add bounded page/pixel/output counts, process deadlines and memory limits, parser isolation, permission checks, explicit prerequisite discovery, safe failure behavior, and tests for malformed/oversized/scanned PDFs, low-quality Chinese, multiple columns and reading order. Runtime extraction here is isolation of installation paths, **not an OS security sandbox**. No source integration or broad architecture decision is implied by this feasibility result.

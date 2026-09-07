# Isolated live model validation

## Status: both live adapters passed; vision fixture correctness failed (2026-09-06)

**The pinned reranker completed actual CPU inference through the existing TypeScript
adapter with correct synthetic ordering. Vision completed real inference and protocol
validation, but did not correctly identify the fixture.** This is not a production-quality, OCR, Chinese vision, or retrieval-quality
claim. No mock response was substituted.

Owned artifacts: `scripts/live-model-smoke.py`, this document, and
`/tmp/studio-model-validation/`.
No shared source/package files, global Python, remote machines, existing model
services, or knowledge bases were changed by this task. Public model downloads
were authorized; inputs for inference are synthetic only.

## Exact models and verification

| Purpose | Public repository | Pinned revision | Weight bytes | Expected safetensors SHA-256 |
| --- | --- | --- | ---: | --- |
| Chinese/multilingual cross-encoder | `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` | `1427fd652930e4ba29e8149678df786c240d8825` | 470592698 | `5daeca2481a76b5976a2bdc32f0a78532b6716da4f8cd3ff59460ef8d2f359b4` |
| Small instruction vision | `HuggingFaceTB/SmolVLM-256M-Instruct` | `7e3e67edbbed1bf9888184d9df282b700a323964` | 513028808 | `74dea5904032e5ae99a2e0eef5179e6ac0f1dedc3ab0c7c2a5d4d387c843203e` |

Metadata was fetched over verified TLS from
`https://huggingface.co/api/models/{repository}/revision/{revision}?blobs=true`.
The script checks repository identity and revision, LFS SHA-256 and size, and Git
blob IDs for small configuration/tokenizer files; it additionally records SHA-256
for every verified file. Git SHA-1 is used only to compare the published Git blob
identifier, not as a new security primitive. Models use local safetensors only,
`trust_remote_code=False`, CPU, and offline inference.

## Bootstrap history

- Initial disk: 106 GiB free; RAM approximately 5.8 GiB available. Resume check:
  106 GiB free disk and approximately 20.7 GiB available RAM.
- Isolated Python 3.11 venv at `/tmp/studio-model-validation/venv`.
  System `ensurepip` was unavailable. `get-pip.py` fetched directly over TLS
  bootstrapped pip inside the venv; no apt/global pip installation.
- CPU-index installation: `torch==2.6.0+cpu`, `torchvision==0.21.0+cpu`;
  PyPI installation: `transformers==4.51.3`. Import checks included both model
  classes, tokenizers/processors, Pillow, and `torch.version.cuda is None`.
- Both metadata responses matched their pinned revisions.
- Reranker `config.json`: 891 bytes, Git blob
  `43ac97f1bef372d4f1d30a32f9a84baffcf6575d`, SHA-256
  `cc2cfe51aa3fd759d21d21acf5dfd6994aa67a3c9210636d22e143699d336c77` verified.
- Python syntax compile, generated Node driver `node --check`, and isolated
  runtime imports passed. Running the combined preflight confirmed independent
  failures for reranker missing `model.safetensors` and vision missing
  `added_tokens.json`; both were recorded without starting a server. Model
  loading and actual Node adapter execution were untested at that point; see
  the mirror recovery results below.

## Earlier upstream network failures (historical)

Initial reranker proxy download stopped after **12,899,932 bytes**:
`curl: (92) HTTP/2 stream 1 was not closed cleanly: CANCEL (err 8)`.
Direct fallback failed:
`curl: (28) Failed to connect to huggingface.co port 443 after 15000 ms: Timeout was reached`.
That partial was subsequently resumed from the mirror and the complete reranker
weight verified. Vision was later completed in the separately authorized continuation below.

On resume, independent HTTP/1.1 8-MiB range probes for each original weight URL
failed: configured proxy returned curl 35 (`SSL_ERROR_SYSCALL`); direct access
returned curl 28 at the 15-second connect deadline. Each probe used no retries,
normal TLS verification, a 90-second transfer cap, and proxy then direct once.
No endpoint credentials or proxy values were printed.

A smaller English-only candidate, `cross-encoder/ms-marco-TinyBERT-L2-v2`, was
considered, but both proxy/direct metadata requests failed with the same network
class. **No revision, weight hash, current maintenance status, or working
alternative was verified, so none was downloaded or represented as proof.** A
smaller artifact does not solve inability to reach the metadata/resolve host.
SmolVLM-256M is already the small vision candidate; no alternative was invented.

## Distinct mirror recovery and real result

Direct `https://hf-mirror.com/{repository}/resolve/{exact-revision}/{file}`
worked without repeating the failed upstream proxy/direct loops. The first
891-byte config probe returned HTTP 200, TLS verification result 0, and exactly
the previously verified SHA-256. Both 64-KiB weight probes returned HTTP 206
with exact Content-Range and expected full sizes. Metadata was **not** fetched
from the mirror: all final checks used the retained verified upstream metadata.

`download-mirror` disables curl config (`-q`), explicitly disables proxies,
strips credential/proxy environment variables, sends no authorization or cookies,
and permits only HTTPS redirects with normal TLS. It probes large files before
8-MiB range downloads, verifies exact range/size before appending, and verifies
final upstream hashes **before** promoting `.part` files. No failed request is
automatically retried. Redirect headers are deleted rather than retaining signed
URLs. Each invocation has one shared budget, at most 900 seconds; this recovery
used a 120-second reranker continuation and a 420-second vision attempt after
the initial roughly six-minute download. Investigation stayed below 12 minutes;
combined active downloads stayed below 15 minutes.

The initial mirror transfer stopped with curl 63 on `special_tokens_map.json`:
its HTTP 307 redirect body is **348 bytes**, larger than the actual **239-byte**
file. The transfer allowance now has a 64-KiB minimum for redirect overhead;
final file size and published blob hash remain mandatory and unchanged. This
was a diagnosed transfer-budget fix, not a hash bypass or blind retry.

### Reranker: actual adapter and synthetic correctness passed

All six selected files verified, including the complete **470592698-byte**
weight with the expected SHA-256 above. The unchanged real
`src/adapters/models/http-reranker.ts::HttpReranker` sent the synthetic Chinese
query `如何让任务等待信号量而不占用CPU？` to the isolated CPU wrapper.
Actual logits mapped back through the adapter were:

| Rank | Candidate ID | Score |
| --- | --- | ---: |
| 1 | `relevant` — blocking semaphore | 3.5171847343444824 |
| 2 | `busy` — CPU-consuming polling | 1.706176996231079 |
| 3 | `unrelated` — cooking | -10.167831420898438 |

Model load/tokenization/forward time: **1.473 seconds**, two CPU threads.
Node exit code **0**, `serverClosed: true`. This establishes actual inference,
protocol integration, ID mapping, and correct ordering for **one synthetic case**;
it is not a held-out quality evaluation or production acceptance claim.

### Vision: real protocol pass, fixture correctness failure

The first attempt stopped without retry at range **402653184–411041791**:
`curl: (28) Failed to connect to hf-mirror.com port 443 after 15001 ms: Timeout was reached`.
It retained **402653184 / 513028808 bytes**. A separately authorized continuation
checked `/proc` for existing work, resumed that exact offset using the same
pinned mirror route with a **420-second shared cap**, and completed without
re-downloading the reranker. All **12 selected vision files** verified against
retained upstream metadata before inference. The complete **513028808-byte**
weight matched SHA-256
`74dea5904032e5ae99a2e0eef5179e6ac0f1dedc3ab0c7c2a5d4d387c843203e`
before promotion from `.part`.

The unchanged real `describeImage` and `visionFingerprints` adapter test ran
independently on the synthetic 256×256 PNG. CPU model processing took
**32.884 seconds**, with two threads, actual EOS (`finish_reason: stop`),
Node exit code **0**, and `serverClosed: true`. Actual returned description:

> The image consists of two geometric shapes: a rectangle and a blue sphere.

**Protocol/inference passed; exact visual fixture identification failed.**
The fixture is a **red square on the left and blue circle on the right**, on
white. The model identified two shapes and blue, but omitted red and positions,
described the square only as a rectangle, and incorrectly described a flat
circle as a sphere. A square is mathematically a rectangle, but that broader
label does not recover the requested specific shape; the sphere claim is
incorrect. No prompt tuning or substitute output was used to manufacture a pass.
This is not an OCR, Chinese vision, or broad visual-quality evaluation.
Gate 2 now has real inference evidence for both adapters, **not an overall
visual-correctness or production-quality pass**.

Fixture SHA-256:
`e7f8e3f30d615b6a4ac6f6c929fce47befeb5b162729c56560f4e40ed857a93f`.
Model fingerprint:
`696253508eb1656b927f224d8e1233ff18540c01ea67bcee0703c671b5e1d8a2`.
Prompt fingerprint:
`092d272871ad14156763353583431691b27a0a065a9a22104b40d0ff984d64cd`.

### Evidence and reproduction

All artifacts below are under `/tmp/studio-model-validation/`:

- `mirror-recovery-probe.json`, `reranker-mirror-range-probe.json`,
  `vision-mirror-range-probe.json`: exact URLs, TLS/range probe diagnostics.
- `token-map-redirect-diagnostic.json`, `token-map-redirect-body.txt`: curl 63 cause.
- `mirror-progress.log`, `mirror-downloads.log`, `reranker-recovery.log`,
  `vision-recovery.log`, `vision-continuation.log`: transfer history; earlier
  errors retained as history.
- `reranker-hashes.json`: all six verified file hashes.
- `reranker-results.json`, `reranker-adapter-result.json`, `reranker-node.log`,
  `reranker-inference.log`: actual independent model/adapter result.
- `vision-hashes.json`: all 12 verified files; the complete verified weight is
  now `vision/model.safetensors` (partial promoted only after hash verification).
- `vision-results.json`, `vision-adapter-result.json`, `vision-node.log`,
  `vision-inference.log`: actual independent vision inference/adapter evidence.
- `vision-correctness-assessment.json`: explicit protocol-pass/visual-fail assessment.

No matching download/inference processes remained in `/proc` at final check.
Python syntax compilation and generated Node driver syntax checks passed.
No runtime reinstall, private input, remote-service operation, or shared-source
change occurred.

Both models are now local and verified. From the repository root:

```bash
# Each run rechecks every selected file before starting its temporary server:
PYTHONDONTWRITEBYTECODE=1 /tmp/studio-model-validation/venv/bin/python scripts/live-model-smoke.py run --kind vision
# Reranker is already complete and independently runnable:
PYTHONDONTWRITEBYTECODE=1 /tmp/studio-model-validation/venv/bin/python scripts/live-model-smoke.py run --kind reranker
```

Without `--kind`, `download-mirror` shares its budget across both models and
stops at the first failure; `run` attempts models independently. Historical
`download` mode still exists but was not used for this recovery.

For reproducing the earlier successful dependency installation in a *new*
isolated environment, commands were equivalent to:

```bash
python3 -m venv /tmp/studio-model-validation/venv
# If ensurepip is missing, retain the partial isolated venv and bootstrap there:
curl --noproxy '*' -fL --connect-timeout 15 --max-time 60 --retry 1 \
  https://bootstrap.pypa.io/get-pip.py -o /tmp/studio-model-validation/get-pip.py
env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY \
  /tmp/studio-model-validation/venv/bin/python /tmp/studio-model-validation/get-pip.py \
  --isolated --retries 1 --timeout 20 --cache-dir /tmp/studio-model-validation/pip-cache
# Bound each pip invocation externally (300s / 240s respectively).
timeout 300 env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY \
  /tmp/studio-model-validation/venv/bin/python -m pip --isolated install \
  --retries 1 --timeout 25 --cache-dir /tmp/studio-model-validation/pip-cache \
  --index-url https://download.pytorch.org/whl/cpu torch==2.6.0+cpu torchvision==0.21.0+cpu
timeout 240 env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY \
  /tmp/studio-model-validation/venv/bin/python -m pip --isolated install \
  --retries 1 --timeout 25 --cache-dir /tmp/studio-model-validation/pip-cache transformers==4.51.3
```

Exact installed transitive versions are retained in `requirements.freeze.txt`;
these commands are a bootstrap record, not a hash-locked package supply chain.

## Adapter smoke contract (both executed)

The script generates a Node driver importing the actual v2
`src/adapters/models/grounded-model.ts::describeImage` and
`src/adapters/models/http-reranker.ts::HttpReranker`. The earlier investigation's
v1 fixed-30-second vision limit was incorrect for this route: **v2 supports an
explicit 180000 ms deadline**, used here for both adapters.

A script-owned server binds `127.0.0.1:0`; the OS-selected free port stays fixed
for that invocation. It accepts one request for the selected model. Inference
runs in a fresh CPU subprocess, at most two threads, with a 170-second hard
subprocess deadline; Node has a 190-second deadline. Server shutdown/close is in
`finally`. Nothing starts until all selected model files verify.

- Reranker: one batch, Chinese semaphore query and three synthetic candidates
  (unrelated cooking, blocking semaphore, busy-wait). Actual logits become a
  full Cohere-style index/score permutation, mapped back to host IDs by the real
  adapter. Scores are not calibrated probabilities.
- Vision: synthetic white 256×256 PNG with a red square left and blue circle
  right. PNG bytes go through real `describeImage` as a base64 image URL; the
  wrapper decodes the received PNG and passes it to SmolVLM's processor/model.
  The system instruction is preserved as user text because this model template
  has no system turn. Greedy float32 generation is capped at 64 tokens; only an
  actual EOS produces `finish_reason: stop`, never a fabricated stop.

Model-specific `*-results.json`, `*-adapter-result.json`, `*-node.log`, and
`*-inference.log` preserve independent results. Vision output includes input
image SHA-256 and v2 model/prompt fingerprints; reranker output includes query,
candidates, adapter identity/fingerprint and returned ID/score ordering.
Fingerprints include the ephemeral endpoint, so are invocation-specific.
Both models now have real inference artifacts. Vision protocol success must not
be interpreted as fixture correctness.
Historical `*-run-error.txt` files describe the earlier missing-file preflight,
not the newer completed inference runs. Partial bytes and download logs are never
substitutes for actual model results.

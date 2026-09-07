# Post-fix synthetic reference validation — partial pass

## Actual result

On **2026-09-06 11:49:07–11:49:47 UTC**, executed exactly **two new sequential synthetic requests** against existing `http://127.0.0.1:18082/v1/chat/completions`, model `qwen3.8-27b-q5`.

- **Required figure: FAIL.** Reference namespaces were correct, but the only answer block was a figure. Unchanged strict host validation rejected `Incomplete answer mappings`. **No validated required answer and no export.** Original-PNG export equality, export citations and manifest validation remain unverified in this live run.
- **No figures: PASS (structural contract).** Server accepted the actual production schema containing `figures.maxItems:0`; `generateAnswer` returned `answered`, a substantive paragraph containing both stated numeric facts, zero figure selections and zero figure blocks. This is not semantic proof of satisfying the question's request for a figure: the unchanged question still asks for the swatch, while policy `none` prohibits it. The model's paragraph says it “should be included,” despite displaying none.

Overall script result is **failure / exit 1**, intentionally reflecting the first rejection. No response repair, fallback, retry or deterministic substitute export. The earlier three-call experiment in `scripts/generation-latency-smoke.mjs` and `docs/generation-latency-validation.md` is unchanged.

## Scope and reproduction

Only new `scripts/generation-reference-smoke.mjs`, this document and `/tmp/studio-generation-reference/` are owned deliverables. Read the complete remote model-service skill and registry, previous latency report/script, current `grounded-answer.ts`, validator and telemetry contract before execution. No production source, frozen 38 cases/gold, private KB, credentials, remote service/configuration or SSH tunnel was changed. No new trivial probe was sent.

```sh
node --check scripts/generation-reference-smoke.mjs
node --experimental-strip-types --test tests/grounded-answer.test.ts tests/model-telemetry.test.ts
# Consumes a NEW authorization budget; do not rerun on the consumed budget:
node --experimental-strip-types scripts/generation-reference-smoke.mjs --run-authorized-synthetic
```

Syntax passed; **19 scoped existing tests passed**, zero failures/skips. No tests added. The test redirect briefly created `/tmp/studio-generation-reference-tests.log`; it was moved into the authorized directory as `tests.log`, leaving no artifact at the former path.

The one-use temporary loopback forwarder receives the actual `generateAnswer` request and injects **only**:

```json
{"max_tokens":2048,"chat_template_kwargs":{"enable_thinking":false},"reasoning_budget_tokens":0}
```

Original `model`, `messages`, `response_format`, `strict:true`, schema and validator are preserved. The script asserts exact original top-level keys, no Authorization header, identical system prompt across calls, and identical input payload except `figurePolicy`. Production naturally builds different schemas for `required` and `none`; the forwarder does not rewrite either. These controls remain experimental, not production adapter capabilities.

Upstream timeout is **179000 ms**, enclosing generation timeout **180000 ms**. At most two sequential upstream POSTs, no retry. A timeout stops further inference; a non-timeout invalid answer proceeds to the predetermined second policy only if health/idle checks pass. Both listeners closed. Initial model identity matched the registry. Initial, before-required, after-required, before-none and after-none health/slot checks all passed; slot 0 had `is_processing:false`. Final observation: **11:49:47.917 UTC**. No repeated status loops or lifecycle commands. These are point-in-time local API observations, not a remote process/GPU audit or an exclusive lock against other clients. Client abort would not prove remote computation stopped; timeout behavior was not exercised here.

## Fresh fixture and assertions

Authored synthetic **Saffron beacon timer** source states a **43-second settling interval** and **9-milliwatt indicator budget**, accompanied by an original decorative identifier swatch, explicitly not a measurement plot. This new fixture is separate from the earlier Lumen fixture and frozen evaluation cases. The same general question asks for both facts plus the original swatch without pixel-derived measurements, under both policies; no response-dependent fixture or prompt edits.

- Text evidence: `saffron-text`; image occurrence: `saffron-swatch`; source: `saffron-source`.
- Newly authored 2×2 RGB PNG retained as `original.png`, provenance `standalone_original`, host-linked to the text. This is source-original synthetic media, not extraction from a public PDF and not a rendition of an existing KB image.
- Qwen receives only text/metadata, **not pixels**.
- Both captured schemas have three evidence-array locations constrained to enum `["saffron-text"]`. Required figure occurrence fields are constrained to `["saffron-swatch"]`, separately from requirement-local labels.
- Under `none`, the figure array has `maxItems:0`, its unused occurrence item is a plain string (no empty enum), and blocks allow paragraphs only.
- Required success would additionally assert one selection/display, both numeric facts in paragraphs, byte-identical exported original PNG, source/occurrence/blob provenance, HTML image and citation references, and every manifest file hash. These checks were **not reached**, not passed.
- None success asserts both numeric values in paragraphs, host strict coverage success, empty selections and zero figure blocks. No export requested for that condition.

## Observed measurements and rejection

| Policy | Upstream transport | Answer event | Prompt / completion / total tokens | Cached tokens | Finish | Result |
| --- | ---: | ---: | --- | ---: | --- | --- |
| required | 21747.054 ms | 21758.702 ms | 926 / 403 / 1329 | 0 | stop | `Incomplete answer mappings` |
| none | 17238.527 ms | 17244.929 ms | 926 / 360 / 1286 | 452 | stop | host-validated answered, zero illustrations |

Upstream request/response bytes: required **6058/2129**, none **5830/2079**. Unmodified production requests: **5963** and **5735** bytes. Upstream header/first-body offsets: required **21745.500/21745.699 ms**, none **17238.174/17238.327 ms**. Validation durations: **0.504 ms** and **1.063 ms**. Numeric reasoning-token usage was absent, not zero. Token/cache counts are provider claims. Non-streaming header/first-body latency is not time to first generated token; no queue/prefill/decode attribution is available.

Required wire response declared four supported requirements (`settling-interval`, `indicator-budget`, `swatch-inclusion`, `no-pixel-inference`), each using only `saffron-text`. Its selection used `occurrenceId:"saffron-swatch"`, `requirementId:"swatch-inclusion"`, `evidenceIds:["saffron-text"]`. Its **only block was that figure**, so all four requirements lacked paragraph coverage. Exact host counts:

```json
{"emptyBlocks":0,"uncoveredRequirements":4,"undisplayedFigures":0,"missingEvidenceMappings":4}
```

Thus the namespace fix is exercised successfully in this sample, but does not solve figure-only generation. The host correctly refused to export the rejected output. The second response mapped all three self-declared supported requirements to its single paragraph using `saffron-text`; selection and figure block counts were zero.

## Evidence and fingerprints

Artifacts: **`/tmp/studio-generation-reference/run-oDB7ar/`**.

- `report.json`: results, exact errors, checks, source fingerprints, transport/pipeline measurements; `sourcesUnchanged:true` confirms all fingerprinted sources were unchanged at completion.
- `telemetry.json`: separate closed content-free events only; no prompts, source text, generated text, reasoning, credentials, URLs or error strings. Content-bearing errors/requests/responses remain separate experimental artifacts.
- `fixture.json`, `original.png`: authored input and initial image bytes.
- `answer-{required,none}-production-request.json`: exact bytes received from the production adapter, before injection.
- `answer-{required,none}-schema.json`, `answer-{required,none}-forwarded-request.json`: captured response format and forwarded request. Report forwarded hashes use compact `JSON.stringify`, matching transport serialization; saved files are pretty-printed.
- `answer-{required,none}-synthetic-response.json`: unmodified parsed provider envelopes, without response repair (not claimed to preserve original HTTP whitespace).
- `answer-none-validated-answer.json`: sole validated result. No required validated-answer file or export directory exists.
- `source-fingerprints.json` and source snapshots with `/` replaced by `__`: exact generation, validation, transport, export and experiment implementation used.
- Parent `console.log`, `tests.log`: execution and offline test results.

| Artifact | SHA-256 |
| --- | --- |
| `src/adapters/models/grounded-answer.ts` | `230192008fdb7bea68008155abe6e42cd694dd9d1b0b9aa6e0c4fde16354b2c4` |
| `src/application/validate-answer.ts` | `af54134b788d5015f372a24004a6f72f89aac1cc0b13e5099e3dc1e5928f36ad` |
| required production request | `181dae747ee162cde0faac1ac2b69b775991026b54dffb0951ec43e6001e797c` |
| none production request | `33bc5324aa0da33ef53bd1f40eaaeec3d3d3f63f8a667b44ca95004d1dd00452` |
| required response format (compact JSON) | `d5c640d849344a16794d13c7bea95780c4b794ade471bed0cb3ab28cdf863e47` |
| none response format (compact JSON) | `8be0a4d578bc5bc923f38995fa4b302eab02876b02201c3949bae5e4e7aa2572` |

## Limits

This is **one failed and one structurally successful synthetic development case**, not held-out quality acceptance, not whole-Studio delivery, not a production latency proof. Even two successful cases would not establish those claims. Policies/schema differ and the second response reports cached tokens; the timings are not a controlled causal comparison. No interactive Pi flow, real-document image extraction, live required-figure export, semantic entailment, production settings change or service improvement is established. The existing three-call findings stand unchanged.

---

## Versioned follow-up: grounded-answer-v2 (2026-09-06 12:07 UTC)

This append-only follow-up does **not** revise the historical results above. New artifacts are in **`/tmp/studio-generation-reference/run-grounded-answer-v2-0Rsutn/`**; `run-oDB7ar` and the earlier three-call experiment were not overwritten. The old report SHA-256 was checked before/after and remained `eaddf01088c4029923452360217d15874cc8cd69db8610e5ffb730cfe895e0d7`.

### Actual outcomes — not two answered successes

Exactly **two sequential new Qwen requests**, **12:07:12.149–12:07:53.368 UTC**:

| Policy | Host result | Experiment result |
| --- | --- | --- |
| `required` | `answered`; strict paragraph coverage passed, four supported requirements, one selected original figure | **PASS**, including actual portable export |
| `none` | Valid `insufficient-evidence`; missing swatch requirement, empty paragraphs/figures, null document | **Zero-figure/schema checks PASS; answered-response check FAIL** |

**Overall script exit: 1.** The existing assertion `Insufficiency is not successful development answer` rejected the second result because it expected `answered` but received `insufficient-evidence`. This is an experiment expectation failure, **not a host validation failure**. The second answer event reports `phase:"complete", outcome:"success"`; its exact assertion error is retained in `report.json`. No acceptance criterion was relaxed after seeing the response, and no repair, fallback or rerun occurred.

Required output contains one substantive paragraph stating **43 seconds** and **9 milliwatts**, explaining the decorative/non-measurement nature of the swatch, and mapping all four requirements to `saffron-text`. Its single selection maps `saffron-swatch` to `include-decorative-swatch`, supported by `saffron-text`. The unchanged v2 host validated all paragraph/evidence coverage before assembling the paragraph followed by the selected figure. Unlike the previous run, the model did not emit a figure-only mixed block response.

Actual export: `document-36d6d80c-57eb-450c-89d1-9b55192b40da/` beneath the new run. Checks passed for one original occurrence, source/occurrence/blob provenance, byte-identical original PNG, HTML image reference and `href="#saffron-text"` citation, and every manifest file SHA-256. Original PNG SHA-256: `079dcd986d6621c80caae25c84d68eea866353e1331bd56abb71fad5fe15f135`.

Under `none`, the same question still requests the original swatch while policy prohibits illustrations. The model assessed `include-swatch` as `missing`, with empty evidence IDs, returning a host-valid abstention with reason `missing-support`. Offline inspection independently verified `wireVersion:"grounded-answer-v2"`, empty wire figures and paragraphs, empty assessment figures and null document. There are **zero illustrations and no second export**, but no answered prose either. That can be a reasonable conservative response to the policy/question conflict; this experiment does not treat it as an answered success or prove the model's support judgment semantically correct.

### Preserved controls and version capture

The existing worker-migrated schema assertions were retained. Script-only additions capture the imported `ANSWER_WIRE_VERSION`, use a fresh `run-grounded-answer-v2-*` directory, snapshot/fingerprint `src/domain/answer.ts`, and assert schema name `grounded_answer_v2`. Both actual schemas constrain the wire version, keep all three evidence-array enums in the text namespace, and have one occurrence-selection field. They contain `paragraphs` with only `text`, `evidenceIds`, `requirementIds`; **no mixed `blocks` or paragraph `kind` fields**. Under `none`, `figures.maxItems:0` was accepted by the server. This supersedes the *current reproduction script's* old-wire behavior, not the historical artifacts above.

Offline deep equality proved the fixture JSON and original PNG identical to `run-oDB7ar`. The question, title, two numeric facts, source metadata, candidate and authored pixels were not changed. This is a **reused development regression**, explicitly **not fresh held-out data**. Only the policy differs between the two production input payloads; the current production adapter generates the appropriate schema and identical current system prompt. The temporary forwarder adds only `max_tokens:2048`, `chat_template_kwargs:{enable_thinking:false}`, `reasoning_budget_tokens:0`; no production request/schema/validator repair or edits.

Each actual upstream request used the unchanged 179000 ms timeout within the 180000 ms generation deadline. Neither timed out. Both forwarders closed. Health and slot 0 idle checks passed initially, before required, after required, before none and after none. Final local observation **12:07:53.367 UTC** was healthy with `is_processing:false`. No repeated status loops, service/config/tunnel/global changes, private KB access, shared source edits or live Pi rerun. Fingerprinted source files remained unchanged throughout this run.

### Measurements

| Policy | Upstream elapsed | Answer event | Validation | Prompt / completion / total | Cached | Finish |
| --- | ---: | ---: | ---: | --- | ---: | --- |
| required | 26319.392 ms | 26329.418 ms | 0.490 ms | 978 / 541 / 1519 | 0 | stop |
| none | 13683.611 ms | 13687.110 ms | 0.229 ms | 978 / 281 / 1259 | 504 | stop |

Upstream request/response bytes: **6154/2800**, **6137/1692**. Production request bytes: **6059**, **6042**. Header/first-body offsets: **26317.736/26317.962 ms**, **13683.436/13683.518 ms**. Token/cache counts remain provider claims; reasoning-token counts are absent, not zero. These are non-streaming transport timings, not first generated token or production latency evidence.

### New retained evidence

The new versioned directory contains `report.json`, content-free `telemetry.json`, exact production request bytes, captured schemas, experimental forwarded requests, unmodified parsed synthetic response envelopes, both host-validated results (including the abstention), fixture/original PNG, source snapshots and `source-fingerprints.json`. `offline-verification.json` records fixture/image equality, zero-figure abstention assertions and old-report hash. Parent logs are **new** `console-grounded-answer-v2.log` and `tests-grounded-answer-v2.log`; old logs remain unchanged.

| Fingerprinted artifact | SHA-256 |
| --- | --- |
| `src/domain/answer.ts` | `93d422a7563a2ac51305fae26a08279026543fd4c41b8134657e6ebfd1e95d64` |
| `src/adapters/models/grounded-answer.ts` | `13ff151acc0ddc029495af39ddd16b8c7c0eab600bc8a2f54b6eba68a6f87d06` |
| `src/application/validate-answer.ts` | `04f051b8e060e9bfa589e5f6b228b4b7786be912a7e6a18226ec436cdca6a207` |
| required production request | `014879d17df9cd28c3c3c9e81135588294e56598e1d920e33fab808266c1ffe1` |
| none production request | `69e64bc56fbce602f0cb9a96bcf878fd5568150c421cd2ab6c942bf26bfcf195` |
| required response format (compact JSON) | `ff9503264f74d07d92e2af8211f97cb2e8f54b1bcb49718e323a153355b6177c` |
| none response format (compact JSON) | `7b5125ee36cc01774ebbbe03677164dcf24df7255e9d3ec5eabb465bc010890b` |

Node syntax passed and **22 current scoped existing tests passed**, zero failures/skips. No tests added. The reported upstream full-suite handoff of 183 tests / 181 passes / 2 skips was not rerun or independently claimed here.

**Interpretation:** actual required-figure export now succeeds in this single v2 development sample; `none` enforces zero figures but abstains. No causal or general improvement claim follows from one sample, different wire/schema/prompt, sequential cache effects and previously seen fixture. Neither this result nor two hypothetical answered successes establishes held-out quality, real-document extraction, semantic entailment, production latency or whole-product delivery. No further requests remain authorized under this consumed budget.

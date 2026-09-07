# Synthetic generation latency experiment — failed answer validation

## Scope and actual outcome

On **2026-09-06 11:32:24–11:33:19 UTC**, ran three sequential, explicitly authorized **new synthetic development** requests against the existing loopback `http://127.0.0.1:18082/v1/chat/completions`, model `qwen3.8-27b-q5`. **One trivial probe passed; both real `generateAnswer` calls failed unchanged host validation. Zero valid answers and zero exports.** This is neither held-out quality acceptance nor a latency-root-cause finding.

Only `scripts/generation-latency-smoke.mjs`, this document and experiment artifacts under `/tmp/studio-generation-latency` are deliverables. No shared source, frozen cases, gold, prompts, model configuration, private KB, remote service or tunnel was changed. No retries, restarts, stops, fallback acceptance or response repair. A console redirect initially landed at `/tmp/studio-generation-latency-console.log`; it was moved into the authorized directory as `console.log`, leaving no artifact there.

## Reproduction and controls

```sh
node --check scripts/generation-latency-smoke.mjs
# Explicit network/inference opt-in; rerunning consumes a NEW three-call budget.
node --experimental-strip-types scripts/generation-latency-smoke.mjs --run-authorized-synthetic
```

Syntax check passed. Actual execution exited **1**, deliberately reflecting failed validation rather than claiming success. Do not rerun under the already consumed authorization without a new budget.

The script fixes the endpoint/model and creates a fresh child below `/tmp/studio-generation-latency`. Initial `/health`, `/slots`, and `/v1/models` passed; each subsequent inference was preceded by healthy/idle checks. Final read-only check at **11:33:19.205 UTC** showed healthy service and slot 0 `is_processing:false`. This is point-in-time local endpoint evidence, not a lock against another client or a fresh remote process/GPU audit. No SSH lifecycle operations were needed or performed.

Read prerequisites: full model-service skill and registry; `docs/model-telemetry.md`; `src/adapters/models/grounded-answer.ts`; and `/tmp/acp-delegate/del_mtpq5ugm_ixwn.out`. The latter pins upstream HTTP evidence to llama.cpp **1464c62d88f699ec9700c8010bbfdbc603a9efd6**, notably `tools/server/server-common.cpp:1072–1095,1126–1139` and `tools/server/server-schema.cpp:44–48`. This run does not independently establish deployed binary/source equivalence.

| Call | Explicit experimental controls |
| --- | --- |
| Trivial | `max_tokens:128`, `chat_template_kwargs:{enable_thinking:false}`, `reasoning_budget_tokens:0`, non-streaming |
| Pipeline disabled | `max_tokens:2048`, `chat_template_kwargs:{enable_thinking:false}`, `reasoning_budget_tokens:0` |
| Pipeline bounded thinking | `max_tokens:2048`, `chat_template_kwargs:{enable_thinking:true}`, `reasoning_budget_tokens:128` |

Upstream transport deadline: **179000 ms**; enclosing `generateAnswer` deadline: **180000 ms**. Maximum three sequential POSTs; no retry. A timeout stops further inference and triggers a read-only residual-slot check. The timeout branch was not exercised in this run. A client timeout would not prove remote computation stopped. Non-`stop` finishes (including `length`) remain errors, never repaired or accepted; no length finish occurred here.

**The one-use loopback forwarder is experimental, not a production adapter capability.** It forwards the actual generated request to the fixed endpoint, adding only the three listed fields; no key/auth header is used. It verifies the original request has only `model`, `messages`, and `response_format`, checks `strict:true`, and compares the second pipeline request against the first with deep equality. System prompt, user payload, conservative AnswerWireResponse JSON schema and `validateAnswer` are unchanged. Both temporary loopback listeners closed in `finally`. This experiment does not add token/thinking controls to Studio's production adapter.

## Fresh synthetic fixture

The authored **Lumen pebble timer** note states a **37-second settling interval** and **6-milliwatt indicator budget**. It describes an accompanying decorative identifier swatch, not a measurement plot. The question asks for both facts and the original swatch without pixel-derived measurements; policy is `required`.

One text evidence ID: `lumen-text`; one image occurrence: `lumen-swatch`; source: `lumen-source`. The host candidate links the swatch to `lumen-text`. The 2×2 RGB PNG is newly authored source media (`standalone_original`), not an original extracted from a public PDF or an existing KB. Its initial bytes are retained as `original.png`; export, if validation succeeded, would have to preserve those bytes, citation links, provenance and every manifest hash. Only text/metadata are supplied to Qwen, **not pixels**. Neither this fixture nor the general schema/prompt was changed after either response.

## Measurements

All values below are observed once per condition, rounded milliseconds. Provider token counts are claims, not independent tokenizer measurements. Header/first-body timings measure a non-streaming HTTP exchange, **not first generated token**.

| Call | Upstream transport | Pipeline answer event | Prompt / completion / total tokens | Finish | Outcome |
| --- | ---: | ---: | --- | --- | --- |
| Trivial disabled | 1934.874 ms | N/A | 26 / 6 / 32 | `stop` | Exact `LUMEN_DEV_OK` |
| Answer disabled | 18318.110 ms | 18330.435 ms | 793 / 351 / 1144 | `stop` | `Incomplete answer mappings` |
| Answer thinking128 | 31752.164 ms | 31756.696 ms | 829 / 649 / 1478 | `stop` | `Unknown answer reference` |

Upstream header/first-body offsets: trivial **1933.390/1933.571 ms**; disabled **18317.425/18317.695 ms**; thinking128 **31751.974/31752.047 ms**. Upstream request/response bytes: **242/640**, **5202/2022**, **5203/3337**. Both pipeline requests before experimental injection were **5107 bytes**. Pipeline validation took **2.167 ms** and **0.128 ms**, respectively. Both answer events reported `cached_tokens:0`; separate numeric reasoning-token usage was absent, not zero. Pipeline transport overhead also includes the local wrapper and saving the synthetic response before relaying it.

### Requirement mappings and concrete rejections

**Disabled response:** all three requirements claimed supported with `evidenceIds:["lumen-text"]`:

- `settling-interval`
- `indicator-power-budget`
- `include-accompanying-original-swatches`

The selected `lumen-swatch` mapped to `include-accompanying-original-swatches` with `lumen-text`. However, **the only block was the figure**: no textual answer paragraphs. Unchanged host coverage diagnostics: `emptyBlocks:0`, `uncoveredRequirements:3`, `undisplayedFigures:0`, `missingEvidenceMappings:3`. Figure display does not replace textual requirement coverage.

**Thinking128 response:** declared `settling-interval`, `indicator-power-budget`, and `no-pixel-measurements` supported with `lumen-text`; `include-swatch` used **both `lumen-text` and `lumen-swatch` as evidence IDs**. The figure mapped to `include-swatch` but listed `evidenceIds:["lumen-swatch"]`. Its first paragraph mapped to the two numeric requirements using `lumen-text`; its last paragraph mapped to `include-swatch` and `no-pixel-measurements` using both IDs. **`lumen-swatch` is an image occurrence, not an allowed text evidence ID**, so requirement validation failed early with `Unknown answer reference`. No final coverage counts were emitted for this early failure.

Both envelopes said `status:"answered"` inside their JSON content and finished `stop`, but **neither became a host-validated AnswerResult**. Figure selection by rejected wire output did not authorize export. No export directory or validated-answer artifact was created; original-PNG export equality is therefore **not verified in this run**, and is not substituted with an independent deterministic export.

## Retained evidence and limits

Artifacts: **`/tmp/studio-generation-latency/run-1oGSqm/`**:

- `report.json`: actual durations, closed telemetry, controls, outcomes and read-only health/idle observations.
- `telemetry.json`: separated content-free upstream/pipeline events; no prompts, generated text, reasoning, URLs or arbitrary provider extensions.
- `fixture.json`, `original.png`, `unaltered-pipeline-request.json`: fresh synthetic input, original bytes and actual unchanged production request before injection.
- `trivial-disabled-synthetic-response.json`, `answer-disabled-synthetic-response.json`, `answer-thinking128-synthetic-response.json`: unmodified synthetic provider envelopes, preserving failures. These are **content-bearing experimental artifacts, not telemetry**; raw provider reasoning, if present, remains here rather than being copied into telemetry.
- `/tmp/studio-generation-latency/console.log`: completed execution output.

This provides a bounded operational comparison, not a causal claim. There is one sample per condition, sequential order, differing template-rendered prompt token counts, no untreated pipeline baseline, no randomized repeats, and no server queue/prefill/decode attribution. The budget field does not guarantee an aggregate 128-token reasoning ceiling; recognition of thinking tags and closure behavior matter. Faster completion here did **not** produce an acceptable grounded answer. Historical 180-second failures cannot be attributed to a single root cause from these samples.

Five-gate mapping: **Gate 1** gets supplementary direct-adapter failure evidence, not another real Pi success; **Gate 4** remains unpassed and frozen cases untouched; **Gates 2/3/5** are not exercised or changed. This document must not be used to check off whole-product delivery.

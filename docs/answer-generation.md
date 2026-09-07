# Answer generation through `ks_v2_generate`

The registered tool now calls `generateAnswer`, not the legacy document-only
`generateGrounded` API. The latter remains available to library callers; old AST
responses are deliberately rejected by the tool, not accepted through a fallback.

## Inputs and consent

Existing collection, query, title, output, limit, lexical/hybrid, and independent
rerank settings are unchanged. Optional `figurePolicy` is `none`, `selective`
(default), or `required`. The original `query` is the generation **question**;
the title is only a separate display title.

Search approval precedes retrieval. Hybrid embedding and optional reranking keep
their separate configuration and approvals. Generation approval discloses the
exact question, title, policy, complete bundle (including OCR assets/provenance),
and host-derived figure candidate captions/text linkage sent to the model.
No image bytes are sent. The host API key remains out of previews.

Figure candidates come only from the active catalog snapshot and bundle text IDs.
The host checks the epoch, source revision, text identity/excerpt/locator and
provenance, and image occurrence identity/hash/locator/origin/rendition/provenance.
Links use captured image `elementIds`, not tool-supplied links or model mappings.
Captions and adjacency are untrusted source metadata, not visual verification.
Inputs are snapshotted before consent and frozen before model dispatch.

## Optional host-only generation controls

No controls are enabled by default. Only `ks_v2_generate` / `generateAnswer`
accept this opt-in; vision requests, vision derivation fingerprints and legacy
`generateGrounded` remain unchanged. Configure the host **before extension
registration**, then reload. These are not tool arguments:

```sh
export PI_KS_V2_GENERATE_PROTOCOL='llama.cpp'
export PI_KS_V2_GENERATE_MAX_TOKENS=2048
export PI_KS_V2_GENERATE_ENABLE_THINKING=false
export PI_KS_V2_GENERATE_REASONING_BUDGET_TOKENS=0
```

| Host suffix (`PI_KS_V2_GENERATE_`) | Accepted values | Exact outgoing field |
| --- | --- | --- |
| `PROTOCOL` | Only `llama.cpp` | Host selector; not sent |
| `MAX_TOKENS` | Canonical decimal integer 1..32768 | `max_tokens` |
| `ENABLE_THINKING` | Exactly lowercase `true` or `false` | `chat_template_kwargs.enable_thinking` (JSON Boolean) |
| `REASONING_BUDGET_TOKENS` | Canonical decimal integer 0..32768 | `reasoning_budget_tokens` |

Each control is independently optional **with the explicit profile**. A profile
alone sends no additional fields. Unset fields remain omitted, preserving existing
wire requests/server defaults. Empty strings, whitespace, signs, leading zeroes,
fractions, exponent notation, out-of-range values, orphan controls and unsupported
profile/settings are rejected before retrieval approvals or any embedding,
reranking or generation egress in the generation tool. Unknown
`PI_KS_V2_GENERATE_*` names are rejected (existing endpoint/model/key/deadline
settings remain supported). Invalid generation settings do not disable vision.

Library callers use `AnswerModelOptions extends GroundedModelOptions`, with optional
`generation: { protocol: "llama.cpp", maxTokens?, enableThinking?, reasoningBudgetTokens? }`
from `src/adapters/models/answer-model-options.ts`. Runtime validation rejects
unknown profile fields and invalid types/ranges before dispatch. The adapter deeply
clones/freezes caller options; the extension uses its immutable registration-time
host snapshot. Approval shows the explicit profile and controls, or null for server
defaults, alongside the existing endpoint/model/deadline and complete disclosure;
no API key is displayed. Refusing approval prevents generation egress. Headless
use still requires the explicit host `generate` grant; there are no tool overrides.

Mapping evidence is pinned llama.cpp commit
[`1464c62d88f699ec9700c8010bbfdbc603a9efd6`](https://github.com/ggml-org/llama.cpp/commit/1464c62d88f699ec9700c8010bbfdbc603a9efd6):
`tools/server/server-common.cpp` maps the Boolean template kwarg and top-level
reasoning budget; `tools/server/server-schema.cpp` accepts `max_tokens` as the
completion cap alias. No endpoint auto-detection, capability probing or server
modification occurs. This profile is a host compatibility assertion, not runtime
attestation. The 32768 ceiling is a conservative client limit, not a guarantee
that the model context can accommodate it. The completion cap includes reasoning
and final tokens. Reasoning budgets depend on recognized thinking tags, can re-arm
per block and are not a strict aggregate reasoning-token limit. Neither a token
cap nor a thinking toggle guarantees latency or valid final output.

The versioned [reference validation](generation-reference-validation.md) reported
one required-figure answer and actual export at **26.329 seconds**, using only an
**experimental forwarder** to inject the three example controls above. This change
makes that shape explicitly configurable; it does not claim a new live validation
or general performance improvement. `finish_reason: "length"` remains an error;
there are no retries, fallback, response repair, relaxed coverage or export gates.

## Results and export

- `answered`: structured status/assessment plus `generatedByModel: true` and
  `semanticProof: false`. Export still requires separate approval of the complete
  document, bundle, original images/derived OCR assets, and excerpts. The original
  retrieval bundle is passed unchanged to export: illustration policy does not
  remove OCR provenance assets. Source epoch is rechecked before model dispatch,
  after the response, and before export.
- `insufficient-evidence`: host-owned message explicitly limited to retrieved
  evidence, structured assessment/reasons, and `document: null`. There is no export
  approval, output directory creation, or output package. Model assessment is
  marked `generatedByModel: true`, but remains non-proof.
- The exact runtime error `No relevant evidence found` is translated into
  deterministic insufficiency (`no-candidates`, `generatedByModel: false`, null
  assessment bundle ID because no bundle exists). There is no generation call or
  generation/export approval. Timeouts, DB failures and other errors still throw.

These are reference/structural checks, not semantic entailment or completeness
proofs. An insufficient result does not establish that the entire corpus lacks
an answer. Optimistic epoch checks are not a cross-process transaction.

## Internal answer wire v2

The model returns only this explicitly versioned internal shape (strict schema name
`grounded_answer_v2`):

```json
{
  "wireVersion": "grounded-answer-v2",
  "status": "answered",
  "requirements": [
    { "id": "r1", "requirement": "Requested fact", "status": "supported", "evidenceIds": ["text-id"] }
  ],
  "paragraphs": [
    { "text": "An evidence-grounded answer.", "evidenceIds": ["text-id"], "requirementIds": ["r1"] }
  ],
  "figures": [
    { "occurrenceId": "original-image-id", "requirementId": "r1", "evidenceIds": ["text-id"], "justification": "Why the requested answer benefits from this linked illustration." }
  ]
}
```

IDs above are illustrative, not allowed fixture IDs. There is **no mixed `blocks`
array**, paragraph `kind`, model-authored caption, or second figure-display mapping.
Missing/wrong versions, old mixed responses (even otherwise valid ones), unknown
fields and malformed responses fail closed; there is no compatibility fallback.
The public `AnswerResult` and `IllustratedDocument` output shapes are unchanged.

Before assembling a document, the host validates every paragraph and requires:

- Nonempty paragraph text and at least one paragraph for `answered`.
- Textual coverage for **every** supported requirement, including illustration-related
  requirements. Every evidence ID declared for each supported requirement must
  occur in paragraph evidence mapped to that requirement.
- Exact requirement/evidence references and their mutual mappings. Figure linkage,
  captions and selection justifications do not count as paragraph coverage.

Only after these checks pass does the host construct public blocks: all paragraphs
in response order, then exactly each explicitly selected figure in selection order.
Figure captions come verbatim from the trusted host candidate (including empty
original captions); occurrence and evidence linkage remain validated. There is no
automatic figure selection, paragraph fabrication, invented caption or response repair.
Selection count remains capped at 100, paragraphs at 200, and the combined rendered
paragraph-plus-figure count at 200, preserving the previous document budget.
Other text, reference, disclosure, response, deadline and approval limits are unchanged.

`none` prohibits selections; `selective` permits omission; `required` needs a
supported selection or insufficiency. Insufficiency requires empty paragraphs and
figures and a genuine structural insufficiency reason. Deterministic no-text
insufficiency still performs approval/input checks and sends no model request.

### Per-request reference schema

`generateAnswer` builds the strict schema from the validated, frozen request input:

- Every `evidenceIds` array in requirements, paragraphs and figure selections
  enumerates only current `bundle.texts[].id` values.
- Selection `occurrenceId` enumerates only trusted host candidate occurrences, not
  all disclosed bundle images. Image and text reference namespaces stay separate.
- Requirement IDs are model-authored local labels, unknown when building the
  request schema. The host validates all `requirementId`/`requirementIds` references.
- Under `none` or zero candidates, `figures.maxItems` is 0; the unreachable selection
  item keeps an ordinary string occurrence field, not an empty enum or sentinel ID.
- Every object has all fields required and `additionalProperties: false`. The
  schema uses objects, arrays, strings and nonempty enums, without mixed-block
  `anyOf`. Host validation independently enforces coverage and budgets.

The one bounded request, immutable approved snapshot, no retries/fallbacks and
independent search/embedding/rerank/generation/export approvals are unchanged.
Telemetry retains its existing count keys: `emptyBlocks` now means empty wire
paragraphs; `undisplayedFigures` is always zero because display is host-owned.
`uncoveredRequirements` and `missingEvidenceMappings` retain their meanings.

## Offline verification and remaining boundary

This redesign follows the figure-only rejection documented in
[generation-reference-validation.md](generation-reference-validation.md).
That historical report and frozen experiment artifacts are unchanged. The append-only report includes a later v2 live development run using an
experimental forwarder; it does not reclassify the earlier failures. No live
request was made for this optional-controls implementation.

Active adapter, extension, telemetry and deterministic real-Pi transport fixtures
use v2. Regressions cover legacy/version/extra-field rejection, strict per-request
reference enums, empty/figure-only/missing/invalid paragraphs, complete evidence
coverage, all policies and zero candidates, exact host captions and linkage,
ordered host assembly, duplicates and combined document budgets. Existing tests
retain approval, snapshot, insufficiency, refusal, truncation, timeout and no-retry gates.

Verification for this bounded change:

- `npm run check`: passed (`tsc --noEmit`).
- Full suite with `PI_KS_OCR_TEST_CONFIG=/tmp/studio-ocr-config-font.json` and
  `PI_KS_OCR_TEST_REQUIRED=1`: **183 tests, 181 passed, 2 ownership-related skips,
  zero failures**. Real local OCR and real Pi RPC smoke tests passed.
- Standalone `node scripts/pi-e2e-smoke.mjs`: passed using actual installed Pi RPC
  with deterministic loopback transport, not live inference. It checks original
  image equality, citations, export, restart and denials.
- Both modified `.mjs` scripts passed `node --check`.

Logs: `/tmp/studio-wire-full.log`, `/tmp/studio-wire-pi-smoke.json`.
Only mocks/loopback test servers and local OCR were used. This verifies the internal
contract and host assembly, **not** live provider support, better model answer
quality, semantic completeness/entailment, latency or whole-Studio delivery.
The model can still omit a requirement or misjudge evidence. Fixed end-of-document
figure ordering is deliberate; arbitrary model-controlled interleaving is no longer
part of the internal answer contract. Future live validation needs fresh approval.

### Optional-controls offline verification

- `npm run check`: passed.
- Required local OCR full suite (`PI_KS_OCR_TEST_REQUIRED=1`,
  `PI_KS_OCR_TEST_CONFIG=/tmp/studio-ocr-config-font.json`): **189 tests,
  187 passed, 2 ownership-related skips, zero failures**.
- Scoped answer adapter/extension tests: **26 passed**, zero skips/failures.
- Standalone `node scripts/pi-e2e-smoke.mjs`: passed with installed Pi RPC and
  deterministic loopback transports; no live inference. The smoke script was
  left unchanged, retaining its isolated environment and not forwarding the new
  host controls. New controls are exercised by unit/mock extension tests.
- Logs: `/tmp/studio-generation-controls-scoped.log`,
  `/tmp/studio-generation-controls-full.log`,
  `/tmp/studio-generation-controls-pi-smoke.json`.

New regressions cover exact payload/default omission, profile-only omission,
zero/upper bounds, malformed/orphan/unsupported settings before all generation-tool
egress, immutable nested snapshots, secret-free consent/refusal, ignored tool
injection, unchanged vision payload/fingerprints and capped-finish rejection.
This is bounded contract verification, not whole-product acceptance.

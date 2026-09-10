# Real Pi operation acceptance

> **Latest versioned result:** grounded-answer-v2 with explicit production host controls
> passed once at 2026-09-06 12:34–12:35 UTC; see the appended section below.
> Earlier sections retain their original wording and measurements as historical
> reports; their “current” labels do not describe the latest wire version.

Validated 2026-09-06 with installed Pi **0.85.1**, using
`/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`.

## Result

**Current answer-contract mock proof:** the complete deterministic-model lifecycle
passed through the real Pi loader, agent loop and registered V2 tool execution
using `AnswerWireResponse`. The scoped command below passed **21/21 tests,
0 skipped**, including the real 14-operation RPC flow and the extension's existing
authority, denial and source-epoch regressions. This is integration/structural
consistency proof, not semantic-support or real-model quality proof.

**Current answer-contract live proof: passed.** One bounded actual Pi run with
live WeMM/Qwen completed all 14 operations using `AnswerWireResponse`, including
required figure selection, both verified exports, process restart recovery and
five denials. Generation plus export took **178156 ms** with a 180000 ms model
deadline. Detailed measurements and artifacts are below. The older live result
remains explicitly PRE-answer-contract and is not reused as current proof.

This live validation follow-up edits only this document; the harness, tests and
extension are owned separately. No installation, existing KB, model service or
host configuration was changed. Only synthetic inputs reached the existing
loopback services.

## Reproduce

From the repository root:

```sh
node scripts/pi-e2e-smoke.mjs --keep
node --experimental-strip-types --test tests/v2-extension.test.ts tests/pi-e2e-smoke.test.ts
# Explicit optional use of existing loopback model services; synthetic inputs only:
PI_KS_V2_GENERATE_TIMEOUT_MS=180000 node scripts/pi-e2e-smoke.mjs --live --keep
```

Without `--keep`, temporary data is deleted, including on failure. With it, stderr
reports the artifact directory containing `rpc-sanitized.jsonl`, exported packages,
and `result.json` on success or `failure.json` on failure. Logs now timestamp events;
results include per-operation wall-clock milliseconds. The host deadline defaults
to 120000 ms and accepts integer values from 1000 through 180000; the RPC wait
budget is that deadline plus 40000 ms. No other host model configuration is inherited.
The test skips explicitly if the fixed installed
CLI is absent; a skip is not acceptance. No installation bootstrap is performed.

The spawned command is equivalent to:

```sh
node /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
  --mode rpc --no-session --offline --no-extensions \
  -e <REPO>/extensions/v2.ts --no-context-files --no-skills \
  --no-prompt-templates --no-themes --no-builtin-tools \
  --provider pi-e2e --model synthetic-driver --thinking off
```

`HOME`, cwd, agent settings, collection and exports are new temporary directories.
The child's environment is allowlisted, with isolated `PI_CODING_AGENT_DIR`,
`PI_OFFLINE=1`, `PI_TELEMETRY=0`; host credentials, provider settings and
`NODE_OPTIONS` are not inherited. The harness creates only a synthetic Markdown
semaphore lesson and a one-pixel PNG. The default HTTP model endpoints bind to
loopback on an ephemeral port. No external network endpoint is configured.
This is configuration isolation, not an OS-level network sandbox.

## Why this is real Pi execution

The loopback OpenAI-compatible **model transport** returns deterministic streaming
`tool_calls`. It checks that the requested tool is actually advertised by Pi and
that no non-V2 tools are advertised. Pi itself loads `extensions/v2.ts`, invokes
the registered tool, and feeds the tool result back to the model. The harness
never imports or calls a tool's `execute`, constructs an ExtensionAPI mock, or
imports the broken installed public SDK entry point.

For every requested operation it checks exactly one `tool_execution_start` and
`tool_execution_end`, the tool name, exact arguments, matching call ID and error
status, then waits for `agent_settled`. Streaming JSONL input/output is handled
without readline. Children and HTTP connections are closed on completion/failure.

Pi RPC exposes `ctx.hasUI=true`. The extension emits actual
`extension_ui_request` confirmations; the harness sends automated
`extension_ui_response` messages using each request's ID. These are **simulated
user decisions over the real RPC UI protocol, not human interactive TUI approval**.
All headless grants are deliberately configured: explicit RPC rejection must
still take precedence over those grants.

## Current answer-contract deterministic acceptance

Scoped tests ran on 2026-09-06 against the updated extension. The test runner
removes temporary artifacts by default; use `--keep` to preserve a new run.
`/tmp/pi-e2e-fqD1XY` is an older, PRE-answer-contract artifact, not current proof.

The generation mock returns only `status`, `requirements`, `figures` and `blocks`:
requirements are supported by existing text IDs; paragraphs carry `requirementIds`;
interactive `ks_v2_generate` now uses one bundled confirmation for retrieval,
optional hybrid/reranking, generation-model egress and automatic export. The
historical sequence below keeps its 14 tool executions and measurements, but
`ks_v2_generate` no longer presents separate generation and export prompts.

selected figures use a host candidate occurrence linked to that supported text,
with an explicit illustration justification. No legacy AST fallback is supplied.
The harness checks the original question (“How does the synthetic semaphore wake
a waiting task?”) separately from the display title (“Synthetic guide”), requests
`figurePolicy: required`, and checks the returned assessment and selected figure.
The direct extension fixture additionally checks `none` and selective omission
with candidates available, plus required selection and rendered image presence.
These fixture support judgments are deterministic, not entailment verification.

| Sequence | Actual registered tool | Check |
| --- | --- | --- |
| 1–2 | `ks_v2_import` | Reject without filesystem changes; approve Markdown plus original PNG |
| 3 | `ks_v2_list` | Imported document visible |
| 4–5 | `ks_v2_index` | Approve index but reject embedding: zero embedding requests; then approve both |
| 6 | `ks_v2_search` | Hybrid query returns text and linked original-image evidence |
| 7–8 | `ks_v2_generate` | Reject the single bundled generation workflow: zero generation requests; then approve the bundled retrieval/model/export workflow |
| 9–10 | `ks_v2_export` | Reject without filesystem changes; then export evidence package |
| 11–12 | `ks_v2_list`, `ks_v2_search` | Stop Pi, start a new process, recover identical document listing and text evidence |
| 13–14 | `ks_v2_remove`, `ks_v2_list` | Reject removal without filesystem changes; document remains |

Counts: **14 tool executions, 5 denied, 28 agent-model HTTP requests,
3 embedding requests, 1 generation request**. Both exports contain six files,
one text excerpt and one original image. Checks include:

- Exported PNG bytes equal the imported original; SHA-256:
  `b1ff9c8ea3a780bad09b346c423d2d0e46815926879b18e841d928376a946640`.
- Markdown contains image markup and rendered evidence citation IDs; HTML contains
  an image element.
- Excerpt text hashes match, source IDs resolve, and original-image occurrence
  hashes match the original bytes.
- Manifest file hashes and lengths match actual package files.
- Generation reports `generatedByModel: true`, `semanticProof: false`.

Sanitized log excerpt (IDs omitted here only for readability; artifact retains
request/call IDs):

```json
{"type":"extension_ui_request","method":"confirm","title":"Knowledge Studio V2: embedding"}
{"type":"extension_ui_response","confirmed":false}
{"type":"tool_execution_end","toolName":"ks_v2_index","isError":true}
```

The log replaces temporary/repository absolute prefixes with `<TEMP>`/`<REPO>`
and omits token deltas and duplicate message history. All source/tool content is
synthetic. It is not a general-purpose private-data redactor.

Scoped test result:

```text
✔ real Pi RPC: full synthetic lifecycle, original image, citations, restart and denials
✔ smoke rejects host generation deadlines above the application maximum
# Plus 19 extension tests, including figure-policy coverage and retained regressions
ℹ tests 21
ℹ pass 21
ℹ fail 0
ℹ skipped 0
```

The scoped run above is the current execution check; older LSP results are not reused as current proof.

## Current answer-contract live acceptance — passed

Executed exactly once on 2026-09-06 (exit 0):

```sh
PI_KS_V2_GENERATE_TIMEOUT_MS=180000 node scripts/pi-e2e-smoke.mjs --live --keep
```

Actual Pi loaded the current extension and executed its registered tools. The
existing WeMM `/embed` endpoint on loopback port 18083 supplied 512-dimensional
embeddings; Qwen `qwen3.8-27b-q5` on port 18082 supplied the generation response.
The agent tool-selection driver was still deterministic. No retry, fallback,
service restart, server configuration change or Qwen reasoning override was made.
The harness restarted only its own isolated Pi child for recovery verification.

Per-operation wall-clock timings include the Pi tool round and confirmations:

| # | Operation | Outcome | Milliseconds |
| --- | --- | --- | ---: |
| 1 | Import | Denied | 598 |
| 2 | Import | Passed | 45 |
| 3 | List | Passed | 10 |
| 4 | Index / embedding approval | Denied | 6 |
| 5 | Live index | Passed | 570 |
| 6 | Live hybrid search | Passed | 455 |
| 7 | Generate | Denied | 17 |
| 8 | Live generate + export | Passed | 178156 |
| 9 | Export | Denied | 8 |
| 10 | Evidence export | Passed | 22 |
| 11 | List after new Pi process | Passed | 294 |
| 12 | Live hybrid search after restart | Passed | 554 |
| 13 | Remove | Denied | 7 |
| 14 | List after denied removal | Passed | 11 |

Total measured run: **180851 ms**. This includes multiple operations, so it is
not the individual model request deadline. No timeout was treated as success.

The result records `answerContract: AnswerWireResponse`, `status: passed`, the
original question separately from the title, and `generationFigurePolicy: required`.
The real model supplied one supported requirement and one selected figure linked
to that requirement's evidence, with a nonempty justification. Assessment provenance
is `model-judgment`, with `semanticProof: false`; structural consistency does not
establish entailment or visual understanding of the one-pixel fixture.

Both packages passed original PNG byte equality (SHA-256 shown above), rendered
Markdown citations and image markup, HTML image presence, excerpt/source linkage,
and manifest file hashes/lengths. Each contains six files, one excerpt and one
original image. Read-only inspection of the generated Markdown additionally found:
“The synthetic semaphore wakes a waiting task when an event arrives.” with its
text evidence citation and the original `assets/b1ff9c8e…6640.png` figure.
Restart recovered identical listing and text evidence; denied removal preserved them.

Resumable artifacts (not the historical run):

- `/tmp/pi-e2e-AQEuMs/result.json`
- `/tmp/pi-e2e-AQEuMs/rpc-sanitized.jsonl`
- `/tmp/pi-e2e-AQEuMs/work/knowledge-studio-v2-exports/generated/document-de072c03-75fc-4eea-80df-a5185ef735e6/`
- `/tmp/pi-e2e-AQEuMs/work/knowledge-studio-v2-exports/evidence/document-3ba64314-76d0-4fb2-acdd-0f5868da3596/`

All five denials used actual RPC confirmation requests with automated replies,
not human TUI approval. Applicable filesystem invariance checks passed. Live
`counts` is agent=28, embedding=0, generation=0: only the loopback driver/mock
transport is counted. These zeros **do not observe real endpoint traffic or prove
zero denied egress**. The result's `counterScope` states this limitation explicitly.
The earlier scoped mock tests are preserved, not rerun or modified by this
live-only follow-up.

## Historical live model attempts and successful retry — PRE-answer-contract

**Everything in this section describes the previous generation contract. It is
historical evidence only, not a successful live run of `AnswerWireResponse`.**

`node scripts/pi-e2e-smoke.mjs --live --keep` used only the generated synthetic
lesson. It reads identity from `http://127.0.0.1:18083/health`, then configures
`http://127.0.0.1:18083/embed` at 512 dimensions, and
`http://127.0.0.1:18082/v1/chat/completions` with model `qwen3.8-27b-q5`.
The Pi agent tool-selection driver remains deterministic even in this mode.

Observed WeMM identity: `tencent/WeMM-Embedding-4B`, revision
`a28b25c5d18cf71ec46b115e06ea79ab00ee4819`.
Artifacts: `/tmp/pi-e2e-EeyGnf/rpc-sanitized.jsonl`.

Real Pi import/list, embedding denial, **live indexing** (`documents: 1`), and
**live hybrid search** (one text and one linked original PNG) passed. Generation
denial also passed. The subsequent approved live generation failed:

```text
ks_v2_generate tool_execution_end isError=true
Model request timed out after 120000 ms
```

The harness correctly failed rather than claiming success or substituting its
synthetic model. Live generation/export/restart acceptance consequently remains
unproven in that run. No server was restarted, reconfigured or stopped. The
attempt was timeboxed rather than repeatedly loading the service. Existing
standalone model smoke results were not treated as a substitute.

### Historical bounded retry: passed before the answer contract

Before retry, read-only `GET http://127.0.0.1:18082/health` returned
`{"status":"ok"}` and `/v1/models` advertised `qwen3.8-27b-q5` (llamacpp).
The prior sanitized confirmation payload contains exactly the synthetic 130-character
lesson excerpt, one source and one original-image metadata record, no PNG bytes.
The timeout was not a health failure. The available log does not expose server
queue time or token timing, so a more specific cause cannot be established.

The command with `PI_KS_V2_GENERATE_TIMEOUT_MS=180000` above then completed the
**entire 14-operation flow**, including all five denials and post-restart hybrid
query. It used the same fixture and live endpoints, no fallback, dummy response,
reasoning override for Qwen, or server configuration change.

Measured wall-clock durations (tool round, including Pi overhead):

| Measurement | Milliseconds |
| --- | ---: |
| Live index | 539 |
| First hybrid query | 445 |
| Approved live generation plus export | 178057 |
| Explicit evidence export | 36 |
| Post-restart hybrid query | 1473 |
| Whole successful run | 182165 |

Both generated and evidence packages passed original PNG byte equality, text
citation/source/hash checks and manifest verification: six files, one text excerpt,
one image each. The new Pi process recovered the same listing and text evidence.
Generation reports `generatedByModel: true`, `semanticProof: false`.

Resumable artifacts: `/tmp/pi-e2e-gsm6lJ/result.json`,
`/tmp/pi-e2e-gsm6lJ/rpc-sanitized.jsonl` and
`/tmp/pi-e2e-gsm6lJ/work/knowledge-studio-v2-exports/`.
The preserved directory includes the isolated collection for inspection.

**Counter limitation:** live `counts` reports agent=28, embedding=0, generation=0
because these are counters on the local mock transport only. The zeros do **not**
mean zero live model requests and cannot prove denial prevented live network
transmission. RPC rejection/error and applicable filesystem invariance are checked;
zero denied-egress is request-counter verified only in the deterministic run.
The harness labels this explicitly as `counterScope` in result/failure artifacts.

## Limits and follow-up

- Default models are deterministic fixtures, not quality, real-model reasoning,
  embedding discrimination, or semantic-support proof. Constant mock vectors
  test integration only.
- No human TUI interaction or autonomous live-model tool-selection quality was
  tested. RPC automated confirmations are explicitly distinguished above.
- Restart checks durable collection recovery in a new Pi process, not saved Pi
  session replay, crash consistency or concurrent writer recovery.
- Denial checks cover import, embedding, generation, export and removal. They do
  not cover every grant combination, late export rejection after paid generation,
  cancellation, successful removal, or all vision/rerank flows.
- One synthetic Markdown/PNG fixture does not replace format/security regression
  suites, held-out retrieval evaluation or production acceptance.
- Early attempts overlapped shared storage refactoring and encountered missing
  `catalog-schema.ts` / `ensureCatalogSchema is not a function`; the later stable
  run passed without any shared-source or installation fix from this task.
- Both historical and current-contract live generation passed with little deadline
  headroom. Current generation plus export took 178156 ms against a 180000 ms model
  deadline. Repeatability, server queue/token timing and latency under load remain
  unmeasured; one successful run is not a reliability claim.


## Versioned follow-up — grounded-answer-v2 + production host controls

**PASS, one actual `--live --keep` attempt, exit 0.** Executed
**2026-09-06 12:34:49.713–12:35:19.141 UTC** against the existing live
WeMM/Qwen services through the real installed Pi bundled CLI. All **14 registered
tool operations / 5 denials**, required figure generation, both exports and
new-process recovery passed. No retry, fallback, response repair or substitute
mock generation was used. This is a reused synthetic semaphore development
fixture, not held-out/private input or whole-product completion.

### Focused harness changes

Only `scripts/pi-e2e-smoke.mjs`, `tests/pi-e2e-smoke.test.ts` and this document
were edited. The harness uses the existing production `answerGenerationFromEnv`
parser and `answerGenerationPayload` validator **before listeners, Pi startup or
any live health/model request**. Only these four additional host values are copied
to the already isolated child environment:

- `PI_KS_V2_GENERATE_PROTOCOL`
- `PI_KS_V2_GENERATE_MAX_TOKENS`
- `PI_KS_V2_GENERATE_ENABLE_THINKING`
- `PI_KS_V2_GENERATE_REASONING_BUDGET_TOKENS`

No host API keys, endpoint/model overrides, other provider settings or
`NODE_OPTIONS` are copied. Unknown generation settings fail closed. Defaults stay
unchanged: no generation controls, 120000 ms timeout. Timeout syntax is now strict
decimal, range 1000–180000 ms. Controls require `PROTOCOL=llama.cpp`, exact boolean
strings and production integer bounds. Mock generation asserts the exact expected
control payload, while retaining explicitly deterministic/non-quality labeling.

Success and failure reports record the imported exact `ANSWER_WIRE_VERSION`,
validated host profile, expected production payload, deadline, UTC boundaries,
per-operation durations and read-only Qwen observations. Live traffic is direct;
this payload metadata is **not an independent packet capture**. No forwarder
injects or repairs the actual request. A timeout ends the flow and triggers one
read-only health/model/slots observation, never inference retry or service stop;
that timeout branch was not exercised by this successful run.

### Checks and exact live invocation

Before live execution:

```sh
node --check scripts/pi-e2e-smoke.mjs
node --experimental-strip-types --test tests/pi-e2e-smoke.test.ts tests/v2-extension.test.ts
npm run check
```

**24 tests passed, 0 failed/skipped** (3252.40627 ms test-runner duration), including
two real Pi mock lifecycles (defaults and controls), exact allowlist/default tests,
malformed deadline rejection and ten malformed-control cases. Malformed cases
stub fetch and assert zero requests even with `live:true`; this proves the
preflight path, not zero denied egress during a successful live flow. TypeScript
and script syntax checks passed. Test log: `/tmp/pi-e2e-controls-tests.log`.

The single consumed live authorization used:

```sh
PI_KS_V2_GENERATE_PROTOCOL=llama.cpp \
PI_KS_V2_GENERATE_MAX_TOKENS=2048 \
PI_KS_V2_GENERATE_ENABLE_THINKING=false \
PI_KS_V2_GENERATE_REASONING_BUDGET_TOKENS=0 \
PI_KS_V2_GENERATE_TIMEOUT_MS=180000 \
node scripts/pi-e2e-smoke.mjs --live --keep
```

Do not rerun that command without a new live authorization. Profile recorded:
`{"protocol":"llama.cpp","maxTokens":2048,"enableThinking":false,"reasoningBudgetTokens":0}`.
Production payload controls:
`{"max_tokens":2048,"chat_template_kwargs":{"enable_thinking":false},"reasoning_budget_tokens":0}`.
Wire contract: **`grounded-answer-v2`**, paragraphs/figures separated; mock schema
assertions reject the old mixed-block shape.

Read the entire remote-service skill/registry and latest reference-validation
report before running. SSH identity, registered task action, remote health and
model identity passed read-only checks. Task output had locale decoding damage;
health/model endpoints, not the task's displayed status, establish availability.
Existing local Qwen health/identity and slot 0 idle passed before launching the
harness and again at its initial and pre-generation gates. GPU utilization was
83%/85%, with 33900/24504 MiB free: contention is a timing caveat, not a service
launch gate here. `ss` was unavailable, so local listener process identity was
not independently verified. No stop/restart/config/tunnel/global change occurred.
Final post-run local read-only health passed and slot 0 was idle. These point-in-time
observations are not an exclusive reservation or proof of remote cancellation.

### Actual timings and output

| # | Registered operation | Outcome | Wall ms |
| --- | --- | --- | ---: |
| 1 | import | denied | 720 |
| 2 | import | passed | 69 |
| 3 | list | passed | 14 |
| 4 | index / embedding | denied | 7 |
| 5 | live index | passed | 898 |
| 6 | live hybrid search | passed | 650 |
| 7 | generate | denied | 21 |
| 8 | live generate + export | passed | **26008** |
| 9 | export | denied | 8 |
| 10 | evidence export | passed | 25 |
| 11 | list in new Pi process | passed | 268 |
| 12 | hybrid search in new Pi process | passed | 570 |
| 13 | remove | denied | 7 |
| 14 | list after denied removal | passed | 12 |

Total harness measurement: **29428 ms**. These are tool-round wall times including
Pi/confirmation/export overhead, not model-only latency, TTFT or a causal speedup
comparison with historical runs. No timeout occurred.

The actual generated paragraph states: “The synthetic semaphore wakes a waiting
task when an event arrives.” One supported requirement (`wake_mechanism`) maps to
one text excerpt; one original figure maps to that requirement/evidence. Host
strict validation passed; `semanticProof:false` remains explicit. Both six-file
packages passed original-PNG byte equality, Markdown citation and image presence,
HTML image presence, text hashes/source linkage, occurrence blob hash and every
manifest entry's hash/byte length. Original PNG SHA-256:
`b1ff9c8ea3a780bad09b346c423d2d0e46815926879b18e841d928376a946640`.
New Pi process recovery returned identical listing/text evidence; denied removal
preserved the collection. Applicable denial filesystem snapshots were unchanged.

### Retained artifacts and limits

New directory: **`/tmp/pi-e2e-uQGSuB/`**:

- `result.json`: passed result, exact version/profile and measurements.
- `rpc-sanitized.jsonl`: actual registered tool starts/ends and automated RPC approvals.
- `work/knowledge-studio-v2-exports/generated/document-9f7b8a40-f35c-4a6d-8139-5e802e04c4b0/`
- `work/knowledge-studio-v2-exports/evidence/document-b2692398-2e95-439a-aa34-bbbb8213f147/`

Old artifact directories/reports were not edited or overwritten; historical
sections above remain intact. In particular, the original reference report still
has SHA-256 `eaddf01088c4029923452360217d15874cc8cd69db8610e5ffb730cfe895e0d7`.

Live counters are **agent=28, embedding=0, generation=0** because only the loopback
mock/driver is counted. These zeros **are not proof of zero denied live egress**.
Actual RPC confirmation denials and tool errors passed, but no independent live
network monitor was installed. Confirmation replies are automated RPC, **not
manual TUI**. Tool choice uses a deterministic driver, **not autonomous quality**.
This single reused Markdown/one-pixel-image fixture does not establish held-out
quality, semantic entailment, real-document multimodal quality, production latency
reliability or completion of the whole Studio.

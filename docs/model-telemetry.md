# Model failure telemetry (diagnostic foundation)

Opt-in, in-process diagnostics for `boundedJsonPost` and `generateAnswer`. There is no default logger, file persistence, external telemetry, retry, inference-setting change or service/configuration change. This is **not a latency fix**, a backend root-cause finding or an acceptance result. Frozen evaluation cases/snapshots are not used or changed.

## API

```ts
import { generateAnswer } from "../src/adapters/models/grounded-answer.ts";
import type { ModelTelemetryObserver } from "../src/adapters/models/http-embedding.ts";

const observer: ModelTelemetryObserver = event => {
  // Forward only this closed event to a bounded, caller-owned sink.
  // Do not attach the question, bundle, endpoint or response.
};
await generateAnswer(options, bundle, question, title, policy, candidates, observer);
// Transport alone: boundedJsonPost(endpoint, body, apiKey, { timeoutMs, observer })
```

The observer is a separate final argument for generation: it is not cloned into model options, included in the approved request or wired into runtime/model configuration. Existing callers need no changes. Use a per-call closure for correlation; events deliberately contain no arbitrary caller/provider identifiers, hashes, model names or URLs.

A call emits at most one terminal `transport` event and one terminal `answer` event. Pre-egress rejection/no-candidates paths emit only an answer event. Each event is a detached, frozen snapshot; synchronous throws and rejected observer promises are swallowed, and observer promises are never awaited. Observers must be quick/nonblocking: synchronous JavaScript callbacks cannot be isolated from event-loop blocking. The caller is responsible for bounded retention.

## Closed event shape

- `operation`: `transport` or `answer`.
- `phase`: `prepare`, `fetch`, `headers`, `body`, `envelope-json`, `completion`, `answer-json`, `validation`, or `complete`. On failure this is the last phase reached.
- `outcome`: `success`, `error`, or `timeout`. Transport identifies deadline aborts as `timeout`; the enclosing answer event reports a transport rejection as `error` in `fetch`. Use the paired transport event for the distinction.
- `elapsedMs`: monotonic elapsed time from this operation's entry to notification preparation.
- Transport measurements, when observed: `requestBytes`, `responseBytes`, HTTP `status`, and entry-relative offsets `fetchMs`, `headersMs`, `firstBodyByteMs`, `bodyCompleteMs`, `envelopeParsedMs`.
- Answer measurements: `validationMs` (validation through result freezing or rejection), `finishReason`, allowlisted `usage`, and coverage failure `coverage` counts.

**Unknown measurements are absent**, not zero, null, guessed or copied from provider extensions. For example, a timeout before headers has no status or response byte measurement. A body timeout retains bytes read so far but has no EOF offset. HTTP error bodies are cancelled rather than inspected and have no byte measurement. Request bytes count serialized UTF-8 JSON; response bytes count bytes yielded by fetch, not compressed wire bytes. The response-budget failure includes the chunk crossing the limit.

`finishReason` is one of `stop`, `length`, `tool_calls`, `content_filter`, `function_call`, or `other`; absent/null provider values are omitted, arbitrary values become `other`. Only `stop` remains acceptable.

`usage` permits nonnegative safe integers only:

| Event key | Provider field |
| --- | --- |
| `prompt_tokens` | `usage.prompt_tokens` |
| `completion_tokens` | `usage.completion_tokens` |
| `total_tokens` | `usage.total_tokens` |
| `reasoning_tokens` | `usage.completion_tokens_details.reasoning_tokens` |
| `cached_tokens` | `usage.prompt_tokens_details.cached_tokens` |

No coercion, totals calculation or provider timing passthrough is performed. Invalid/absent fields are omitted, and an empty usage object is omitted. Reported counts are provider claims, not independent tokenizer measurements. Prompts, evidence, generated text, reasoning text, API keys, URL query strings, error messages and arbitrary metadata never enter emitted events.

## Strict coverage diagnostics

`validateAnswer` throws `AnswerCoverageError` for the existing final coverage check. Its message remains exactly `Incomplete answer mappings` for substring compatibility; `category` is `incomplete-answer-mappings`. Frozen `counts` (also emitted as `coverage`) distinguish:

- `emptyBlocks`: 0 or 1;
- `uncoveredRequirements`: requirements lacking mapped paragraph coverage;
- `undisplayedFigures`: selected figures not displayed;
- `missingEvidenceMappings`: missing requirement/evidence pairs across all mapped paragraphs (the same evidence ID required by two requirements counts separately).

There are no IDs or text in these diagnostics. Earlier malformed shape, unknown reference, false paragraph mapping, duplicate figure and insufficiency checks still reject unchanged; they are distinguished by generation phase, not relabeled as coverage failures. The general system instruction now explicitly requires every supported requirement's evidence IDs to appear across paragraphs mapped to that requirement, and each selected figure to appear exactly once. No automatic repair, relaxed validation or case-specific hinting is added.

## Interpretation and retained limits

Header/first-body-byte times describe a non-streaming HTTP exchange, **not first generated token**. They cannot distinguish server queueing, prefill, reasoning, decode or buffering. EOF includes reader cleanup before recording; validation includes host checks and freezing. A client timeout does not establish that server computation stopped. Missing server timing/token metrics remain unknown.

Approval gates, endpoint validation, HTTPS outside loopback, redirect rejection, single request/no retries, input limits, 4 MiB request and 8 MiB response budgets, and the existing 1..180000 ms transport deadline remain intact. Telemetry does not add token/reasoning controls or extend deadlines.

## Offline verification

`tests/model-telemetry.test.ts` uses fresh synthetic latch data and loopback-only HTTP servers: delayed headers/body, pre-header/body timeouts, partial bytes, HTTP status errors, malformed envelope/answer JSON, finish-length/unknown rejection, numeric usage filtering, secret sentinels, coverage counts, and throwing/rejecting observers. Existing transport and answer tests cover unchanged safety/rejection behavior.

```sh
npm run check
node --experimental-strip-types --test tests/model-telemetry.test.ts tests/http-embedding.test.ts tests/grounded-answer.test.ts tests/grounded-model.test.ts
```

Implementation verification: TypeScript passed; 25 scoped tests passed, 0 failed/skipped. No external network or inference was used.

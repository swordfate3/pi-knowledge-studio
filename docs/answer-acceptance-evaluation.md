# Gate 4: frozen answer-path acceptance design (2026-09-06)

**Not a quality pass.** The 40-slot design currently has **38 eligible, evaluator-text-reviewed cases and two deferred genuine-conflict slots**. The initial offline freeze generated zero model answers; the separately frozen authorized four-case inference attempt below returned zero valid AnswerResults. Independent human gold review, pixel adjudication and end-to-end acceptance remain incomplete. This is not a replacement claim for the exposed MindSpore pilot.

Only new `scripts/evaluate-answer-acceptance.ts`, this document, and `/tmp/studio-answer-acceptance/` are owned by this evaluation. No production code, extension, dependencies, model services or existing knowledge bases were modified. The initial offline phase made no model calls. The subsequent explicitly authorized experiment below calls only the existing Qwen endpoint; no embedding, WeMM, vision or reranking service is invoked. A retained dependency copy is not a dependency installation/change.

## Corpus and acquisition

Two different official source families, neither MindSpore nor synthetic unit fixtures:

- **Pillow Concepts**, complete acquired RST, 239 lines: `https://pillow.readthedocs.io/en/stable/_sources/handbook/concepts.rst.txt`.
- **Pillow Tutorial**, acquired complete but corpus deliberately restricted to lines **1–225**, through “Merging images”: `https://pillow.readthedocs.io/en/stable/_sources/handbook/tutorial.rst.txt`. Seven original linked image files acquired from the official `_images/` directory: `show_hopper.webp`, `hopper.jpg`, `thumbnail_hopper.jpg`, `cropped_hopper.webp`, `pasted_hopper.webp`, `rolled_hopper.webp`, `merged_hopper.webp`. Six are requested by gold; the seventh is a real nearby distractor. No visual content labels were inferred.
- **Requests Quickstart**, complete acquired RST, 573 lines: `https://requests.readthedocs.io/en/latest/_sources/user/quickstart.rst.txt`.

Only these three explicit public text inputs and seven linked assets are indexed into the isolated runtime. External cross-references are not followed. This is deliberately a narrow corpus, not broad domain coverage. Scope is included in every question. The tutorial excerpt limitation is explicit, not an undisclosed claim to have indexed the whole page.

The original RST bytes are retained. Packaging keeps RST as text in `.md` files, replacing only seven `.. image::` directives with local Markdown image links, preserving line count and order. No query-oriented captions or retrieval annotations are added. This is **not** a general RST conversion benchmark; RST markup remains in evidence. Source lines map identically to corpus lines in the included scope. Import produced **3 documents, 53 text elements, 7 image occurrences**, with no importer failure.

### Bounded requests and legal limits

Initial five raw GitHub GETs failed with `OpenSSL SSL_connect: SSL_ERROR_SYSCALL`. ReadTheDocs then provided concepts, tutorial, About (license pointer), quickstart and Recommended Extensions. The last is **not a license** and is excluded from the corpus; its initially misleading local filename `original/requests-license` is retained for audit, not cited as legal authority. A proposed `community/license.rst.txt` URL returned 404. Subsequent exact GitHub `LICENSE` requests succeeded for both projects. Seven explicit linked image GETs succeeded. Two HTTP HEAD probes checked documentation accessibility. No recursive crawling or retry loop occurred.

GETs had 5-second connection / 15-second transfer bounds, TLS verification and no redirect following; main source/image acquisition also had a 2 MB cap. Two legal followups had the time bound but no size flag (actual license sizes 1,457 and 10,142 bytes). `manifest.json` records this retrospective acquisition history, exact URLs and byte hashes; it is **not** a fabricated per-request timestamp log.

- `original/pillow-LICENSE`: MIT-CMU, explicitly granting copying/modification/distribution of documentation; retain copyright and permission, no advertising endorsement.
- `original/requests-LICENSE`: Apache-2.0; retain attribution/license and check upstream NOTICE requirements before redistribution.
- **Figure legal caveat:** original Hopper images are linked from official Pillow docs, but separate underlying photo rights/provenance have not been independently cleared. Keep artifacts local for evaluation; do not claim blanket redistribution clearance merely from the repository license. Legal review remains a delivery condition.

Mutable stable/latest/main URLs are pinned by acquired SHA-256 bytes, **not an immutable upstream commit**. `/tmp` is ephemeral: copy the complete directory to approved durable storage before cleanup.

## Frozen design and gold separation

`questions.json` contains only IDs, original questions, and figure policy. `gold.json` contains expected outcomes, fact lists with document/line supports, required original figure hashes/locators, and review limitations. Gold is never ingested, embedded, or included in model messages. `prepare.py` reproduces packaging/questions/gold from retained original bytes; it does not acquire more data.

| Primary category | IDs | Count | Expected result |
|---|---|---:|---|
| Answerable text, generally multiple required facts | A01–A24 except A03, A16, A23 | 21 | answered |
| Hard negatives: standards, JSON success, timeout semantics | A03, A16, A23 | 3 | answered with distinction |
| Explicit original-figure linkage + multiple textual facts | A25–A30 | 6 | answered with required occurrence |
| Missing numerical/deployment information in the scoped text | A31–A36 | 6 | insufficient-evidence |
| Contradicted user premise, not conflicting sources | A37–A38 | 2 | answered, correct premise |
| Genuine mutually conflicting evidence | A39–A40 | 2 reserved | **deferred, not scored** |

Exact IDs and categories in `gold.json` are authoritative. These total **32 answerable + 6 insufficient = 38**, not 40 scored. A39/A40 contain no invented question or label. No mutually conflicting official statements were acquired; false-premise correction is not relabeled as true conflicting-evidence abstention. The missing-information labels are restricted to the entire explicitly named acquired text scope, not worldwide absence. Questions concern operational/numerical information rather than uninspected image content.

Gold is authored from inspected public prose/code, independently of model output but **not independently human-adjudicated**. Model semantic self-assessment is never treated as gold. Six figure labels establish explicit original link identity only; they do not assert pixels, visual relevance, or sufficiency. Facts use coarse source spans, sometimes a whole explanatory paragraph: a hit does not prove every required fact was retrieved or entailed.

## Freeze artifacts

Root: `/tmp/studio-answer-acceptance`.

- Canonical freeze: `objects/66443138c4d333b4f68ead4b1e0d1ecf32a95c7d16c66d14bf6bfd4ebac02e74.json`.
- `freeze-pointer.json` identifies this SHA-256; `freeze.json` is the working copy checked against it before scoring.
- `original/`: acquired unmodified text, legal files and linked image bytes.
- `corpus/`: only the three packaged inputs and seven original image assets.
- `manifest.json`, `design.json`, `questions.json`, `gold.json`, `prepare.py`: separately frozen input files.
- `implementation/`: copied source, runner, package/lock and complete dereferenced dependencies. Freeze records **55 code/package/runner hashes**, **14,455 dependency-file hashes**, **29 input hashes**, Node `v24.20.0`, and exact parsed snapshot/source IDs/revisions/elements/image locators.
- `objects/<sha256>` archives raw/corpus/gold/protocol/code bytes. Dependencies remain in the retained implementation with verified hashes. SQLite state and original/derived blobs remain in `runtime/`.

All of this froze **before lexical scoring**. Scoring rejects changed code, dependencies, input bytes, Node version or catalog and repeats verification afterward. Source/revision/locator/blob identities resolve via the frozen snapshot, not basename matching. Fresh runs are exclusive-created and have preflight records binding freeze, mode and explicitly declared model identity before any question dispatch. Actual model revision is operator-declared, not remotely attested by this runner.

A pre-freeze archive bug attempted to overwrite a duplicate content-addressed read-only object. It failed **before a freeze or scoring**. The evaluator-only archive routine was fixed to exclusive-create and verify existing hashes. Its unused copied implementation/runtime are retained under `failed-pre-freeze-implementation/` and `failed-pre-freeze-runtime/`; they are not valid evaluation results. No corpus, labels or production behavior changed in response to scores.

## Executable answer path

The runner uses the actual APIs:

1. `KnowledgeRuntime.search(question, 10)` with lexical retrieval only.
2. `buildAnswerContext(bundle, frozenSnapshot)` to verify captured evidence and host-linked figures.
3. `generateAnswer(...)` for actual validated `AnswerResult`; the original question and fixed figure policy go to the model, never gold.
4. Exact documented empty-search outcome becomes `emptyAnswer(question)`; all other retrieval/transport/schema/validation failures remain **errors**, never successful abstentions.
5. For actual answered results, `exportPortableDocument(...)` exports the model document and selected original assets locally. Answer records are persisted **before** export; an export error is retained separately and cannot erase the answer outcome.

The original frozen runner used a 30-second bound. The versioned runner below requires explicit `ANSWER_TIMEOUT_MS` (integer 1..180000), no retries/fallback. Explicit endpoint/model/revision and egress approval are required; there is no default Qwen/WeMM endpoint or embedding path. No LLM judge is invoked.

```bash
# Offline validation on the frozen implementation (already executed):
cd /tmp/studio-answer-acceptance/implementation
node --experimental-strip-types scripts/evaluate-answer-acceptance.ts self-test
node --experimental-strip-types scripts/evaluate-answer-acceptance.ts lexical

# FUTURE ONLY: after separate authorization; not executed for this task.
ANSWER_ENDPOINT='http://127.0.0.1:PORT/v1/chat/completions' \
ANSWER_MODEL='approved-model-id' \
ANSWER_MODEL_REVISION='declared-immutable-revision' \
node --experimental-strip-types scripts/evaluate-answer-acceptance.ts score --approve-model-egress
# Optional ANSWER_API_KEY is sent only to the approved endpoint and not recorded.
```

Do not rerun `freeze` over existing artifacts; it refuses replacement. To rebuild, first preserve the entire current directory, reconstruct exact inputs from archived objects and use an empty artifact/runtime root at this same fixed path (source IDs are path-derived). Run `freeze` from the desired immutable implementation; a new freeze is a new experiment, not a replacement for the old result.

## Supported automated metrics

Every actual answer/error remains available per question. No hardcoded `abstained:false` exists.

- **False abstention:** actual insufficient-evidence on answerable gold / **all 32 attempted answerable cases**. Errors are separately counted and remain in the attempt denominator; also inspect successful-answer-result count to avoid mistaking failures for success.
- **Correct abstention:** actual insufficient-evidence / **all 6 attempted missing-info cases**. Errors receive no abstention credit. Genuine-conflict abstention has **zero eligible cases**, not a perfect score.
- **Reference integrity:** existing retrieved evidence IDs / all paragraph references. Structural validity, not entailment. Zero references yields `null`, not 1.
- **Cited-locator completeness proxy:** fraction of gold facts whose support span overlaps any cited captured evidence from the correct frozen document. Per-fact retrieved-locator hits are also retained. **This is not semantic answer completeness.** `semanticCompleteness` and `citationEntailment` remain `null` pending independent review.
- **Selected figure occurrence recall:** requested source/revision-bound occurrences actually displayed / requested occurrences. **Strict request precision:** correct requested displayed occurrences / all displayed occurrences. Unrequested figures get no request credit, not a fabricated visual-irrelevance label. Matching uses frozen parsed identity, exact source line and original SHA-256.
- **Original-byte preservation:** independently rehash selected returned original blob bytes. Export file hashes are retained separately. Pixel correctness remains `null`.
- **Model self-judgment:** complete `assessment` (including requirement statuses) retained as model output, not an independent success measure. Structural requirement IDs do not establish that all user requirements were represented.
- Errors, stage, latency, raw actual result, retrieved bundle, local export status and post-run drift status are preserved. Empty denominators are `null`.

There is intentionally no automatic overall quality pass threshold or semantic score invented after seeing output. A release decision needs a separately approved acceptance rubric and independent adjudication; the runner always reports gate4 incomplete until these outside requirements are satisfied.

## Original offline result and remaining acceptance work

Canonical lexical result:

`/tmp/studio-answer-acceptance/runs/2026-09-06T10-47-24.153Z-b5a5ae92-963f-44d0-8b7e-01b1b6223f33/summary.json`

- 38 eligible / 40 target; 38 retrieval-only attempts; **0 retrieval errors**.
- Frozen implementation/dependencies/corpus/gold/catalog unchanged after scoring.
- **0 model answers, 0 quality measurements, 0 model exports**. Abstention and answer metrics are `null`, not zero or passing.
- Runner self-test checks deterministic insufficient evidence, false/correct abstention accounting, errors receiving no abstention credit, null zero denominators, and the real `generateAnswer` adapter under an injected failing transport. Global fetch is replaced only inside that offline test and restored; no HTTP request occurs. This is runner validation, not synthetic quality gold.
- Standalone strict TypeScript checking of the new runner and its imports passed. No full-suite production claim is made by this evaluator.

Required next steps, without tuning against this exposed set:

1. Acquire defensible genuine-conflict cases or formally reduce the target; retain deferred denominator history. Broaden families if broad generalization is required. Newly acquired gold requires a new freeze before inference.
2. Independent reviewers verify each fact/span and absence scope, adjudicate semantic completeness and citation entailment from actual answers, and record per-fact supported/omitted/incorrect plus reviewer identity and disagreements. Model assessments cannot fill this ledger.
3. Visually inspect originals and exported figures, adjudicate whether each requested source occurrence is appropriate and readable, and distinguish original-file preservation from rendered appearance. No pixel labels may be backfilled from captions alone.
4. Resolve original-photo redistribution provenance and Requests notice obligations before sharing packages.
5. Obtain separate model egress authorization, declare model revision and run real inference/export. Review every error and every false abstention; test generated package rendering interactively. Do not call offline retrieval or adapter tests end-to-end acceptance.


## Authorized inference experiment and watchdog recovery

This section supersedes the earlier future-only inference instructions. **No model-quality pass: four dispatch claims / 38 eligible, three recorded errors, one interrupted unknown, zero valid AnswerResults and zero exports.** The remaining 34 eligible cases have not been dispatched; two target slots remain deferred.

Experiment directory:
`/tmp/studio-answer-acceptance/experiments/2026-09-06T10-57-12.840Z-9d9b959c-1b93-4871-9a62-ed0ee1654ca1`

`experiment.json` SHA-256: `82f65bf6b87abe14144e2cdc3b84da31b6f9e31b658113394b2463c1de023f37` (pointer in `experiment-pointer.json`). It explicitly binds the unchanged original freeze `66443138c4d333b4f68ead4b1e0d1ecf32a95c7d16c66d14bf6bfd4ebac02e74`, unchanged corpus/questions/gold/catalog and original results, plus a copied execution implementation and dependency hashes. Only code differences from the old snapshot are `scripts/evaluate-answer-acceptance.ts` and the main agent's approved `src/adapters/export/portable-export.ts` duplicate-occurrence fix. The evaluator did not edit that production file. Old freeze/code/labels/results were not overwritten. Original and executing code/dependencies, inputs and catalog are checked before and after completed runs.

Protocol fixed before inference: sequential `A01,A31,A25,A37`, timeout 180000 ms per HTTP request, zero retries/fallback, lexical retrieval, existing `http://127.0.0.1:18082/v1/chat/completions`, `qwen3.8-27b-q5`. Identity is **operator-declared, not immutable backend attestation**. No prompts, gold, or retrieval implementation were tuned. The only live destination was that approved endpoint. Timeout bounds the HTTP request, not retrieval/hash/export overhead or remote compute after a client interruption.

Strict TypeScript and offline self-tests passed before dispatch. Four-case lexical validation passed without drift at `runs/2026-09-06T10-57-58.569Z-cced5986-0b8c-4750-bbf8-7ea07244f210/summary.json` under this experiment.

| Case | Predetermined role | Actual outcome | Relative live result |
|---|---|---|---|
| A01 | first answerable | `Model request timed out after 180000 ms` | `runs/2026-09-06T10-58-30.521Z-f04e38cb-2bfe-4d4f-ba84-fb95eb840e14/A01.json` |
| A31 | first missing-information | dispatch claimed, watchdog interruption, **unknown outcome**; not retried | `recovery-interruption.json` and `claims/A31.json` |
| A25 | first required-figure | `Model request timed out after 180000 ms` | `runs/2026-09-06T11-05-25.679Z-5a584444-5f4a-400b-98d5-ce9fa3c4e714/A25.json` |
| A37 | first contradicted premise | `Incomplete answer mappings` validation error | `runs/2026-09-06T11-10-28.454Z-bd9185a0-1795-4fcc-b2ee-acc781b22bb9/A37.json` |

The initial batch was killed by the supervisor watchdog after A01 and during claimed A31. Recovery inspected `/proc` (no `ps` required) and found no evaluator subprocess remaining. Remote request completion cannot be inferred from this. It preserved/hashes existing records, marked A31 unknown separately, then dispatched only unclaimed A25 and A37 as single-case subsets using the **unchanged frozen experiment runner**, with shell progress every 20 seconds. Both completed runs report `unchanged:true`. `recovery-aggregate.json` binds all recorded case file hashes and confirms every pre-recovery artifact remains unchanged. It is a separate aggregation, not a fabricated summary of the interrupted run.

All three recorded errors retain retrieved bundles and stage/latency. A37's adapter validation failure is an error, not abstention; the adapter does not expose its invalid raw model response through the thrown error, so **raw rejected output is unavailable**. No actual valid answer or export exists to measure references, semantic completeness or figure identity. No result was invented for A31. Observed false abstentions are 0 over three attempted answerable cases, but all three failed, so this gives **no successful-result quality denominator**. Missing-information success gets no credit (one unknown claim, zero valid results). Aggregate semantic/reference/figure/pixel metrics stay `null`.

### Safe resume mechanics (no additional calls executed)

The runner requires `ANSWER_TIMEOUT_MS` and comma-separated `ANSWER_CASE_IDS`. Every score subset must be inside its immutable experiment protocol. A persistent exclusive `claims/<ID>.json` is written before case work; already claimed cases are rejected even after timeout/interruption. Existing result files use exclusive creation. Claims without results mean unknown/interrupted, not untested. Never delete a claim to bypass this rule.

Example for an **unclaimed** allowed case only (all four cases in this experiment are now claimed, so this experiment has nothing left to dispatch):

```bash
E=experiments/2026-09-06T10-57-12.840Z-9d9b959c-1b93-4871-9a62-ed0ee1654ca1
cd /tmp/studio-answer-acceptance/$E/implementation
ANSWER_EXPERIMENT=$E ANSWER_TIMEOUT_MS=180000 ANSWER_CASE_IDS=UNCLAIMED_ALLOWED_ID \
ANSWER_ENDPOINT=http://127.0.0.1:18082/v1/chat/completions \
ANSWER_MODEL=qwen3.8-27b-q5 \
node --experimental-strip-types scripts/evaluate-answer-acceptance.ts score --approve-model-egress
```

For the remaining 34 eligible cases, first declare the next authorized fixed subset, exclude all four prior claims across experiments, and create a **new** `snapshot-experiment` from the retained execution implementation, binding the same old corpus/gold/source freeze. Preserve this experiment and aggregate; never expand its manifest in place. Run offline checks and then single-case subsets with progress between calls. Cross-experiment claims are **not automatically enforced**: the operator must retain/check the prior aggregate and declare exclusions; creating another experiment is not permission to retry failures. No further inference is authorized/executed by this four-case task. Human gold review, semantic entailment/completeness, visual figure adjudication, legal provenance and real portable rendering acceptance remain outstanding.

## New grounded-answer-v2 bounded regression — 2026-09-06 12:42 UTC

**New version only; not a replacement freeze or fresh holdout. Gate4 remains incomplete.** The operator separately authorized exactly the already-exposed ordered subset `A01,A31,A25,A37`. The earlier experiment, all claims/results, and specifically **old A31 interrupted/unknown** remain unchanged. The new A31 result does not resolve the old request's unknown outcome. No broader 38-case dispatch occurred.

Experiment: `/tmp/studio-answer-acceptance/experiments/2026-09-06T12-41-07.816Z-adfcc7ac-85d7-4d17-b954-7ea0bd976f01`.

- Experiment SHA-256: `674edc16c9eb18f382f88c3f6a09d53087ced7d5f45c6ccd474c32aa8f3234e8`.
- Run: `runs/2026-09-06T12-42-22.169Z-cbf22625-ed94-469e-9bc4-7183f8ca8309/summary.json` under that experiment.
- Original freeze remains `66443138c4d333b4f68ead4b1e0d1ecf32a95c7d16c66d14bf6bfd4ebac02e74`.
- Snapshot retains 56 code/package/runner hashes and 14,455 dependency-file hashes. Differences from original: evaluator, `src/adapters/export/portable-export.ts`, `src/adapters/models/grounded-answer.ts`, `src/adapters/models/http-embedding.ts`, `src/application/validate-answer.ts`, `src/domain/answer.ts`, and new `src/adapters/models/answer-model-options.ts`. Production changes are other workers' existing implementation, copied without editing. Package/dependency snapshots were copied, not installed or repaired.
- New protocol freezes optional `answerGenerationFromEnv(process.env)` output (absent means `null`), exact ordered subset, timeout, model and exposure status. Controls: `PI_KS_V2_GENERATE_PROTOCOL=llama.cpp`, `PI_KS_V2_GENERATE_MAX_TOKENS=2048`, `PI_KS_V2_GENERATE_ENABLE_THINKING=false`, `PI_KS_V2_GENERATE_REASONING_BUDGET_TOKENS=0`; `ANSWER_TIMEOUT_MS=180000`. These are explicit host options, not inferred endpoint defaults. Existing endpoint/model remain `http://127.0.0.1:18082/v1/chat/completions`, `qwen3.8-27b-q5`; no immutable backend attestation.
- Before health or inference egress, the copied runner compares profile, exact ordered subset, model and timeout to protocol and verifies original freeze/code/dependencies/corpus/gold/catalog/results and all previous experiment files. Post-run verification returned **unchanged:true**. Claims use exclusive creation before each case dispatch. Timeout stops remaining dispatch, retaining explicit not-attempted records; no retry/fallback. This run had no timeout and attempted all four once.
- Read remote skill/registry first; read-only SSH/task/remote health and local health/model/idle-slot checks passed. All eight before/after case observations show health `ok` and slot 0 idle. Only content-free slot state/model IDs are retained, not slot prompts. No service, configuration, tunnel, global setting, private input or other worker file changed.

### Offline validation

Checkout self-tests, project `tsc --noEmit`, and standalone strict runner typecheck passed before snapshot. Frozen self-tests passed, including optional profile parsing and protocol mismatch rejection without egress. Invoking the dereferenced copy's `node_modules/.bin/tsc` failed with `Cannot find module '../lib/tsc.js'` because copying dereferences the launcher symlink; this log is preserved. Invoking the unchanged retained compiler directly with `node node_modules/typescript/lib/tsc.js` passed standalone strict runner/import checking. No dependency repair was made. Frozen logs are `offline-validation.log` and `offline-tsc-direct.log`. These checks are not quality gold or a full-suite result.

### Actual outcomes (not just schema success)

| Case | Validated result | Model adapter time | Cited fact-locator proxy | Required figure recall |
|---|---|---:|---:|---:|
| A01 | answered | 27.017 s | 2/2 | 0/0 → null |
| A31 | insufficient-evidence, expected abstention | 12.119 s | 0/0 → null | 0/0 → null |
| A25 | insufficient-evidence, **false abstention** | 27.461 s | **0/2** | **0/1** |
| A37 | answered, premise correction | 31.458 s | 2/2 | 0/0 → null |

**4/4 structurally valid AnswerResults**, consisting of **2 answered + 2 insufficient**, with **0 inference/validation errors**. This is not four successful answers. False abstention is **1/3 attempted answerable cases**; correct missing-information abstention is **1/1**. No genuine-conflict case was scored.

A01 actually states same dimensions/depth and `getbands`; A37 actually rejects user-defined modes and gives a sequence of Image objects. These are retained model paragraphs, not independent semantic adjudications. Across the three answerable cases, all **6/6 fact support spans** were retrieved, but only **4/6** were cited in displayed answers. Existing paragraph reference integrity is **3/3**, not entailment. A25's requested occurrence is present in its retrieved bundle, but the model marks the illustration requirement missing and returns no document. That is an observed false abstention against frozen gold, not proof of its precise root cause or a reason to tune prompts/gold. Requested figure recall is **0/1**; displayed-figure precision **0/0 → null**. No selected original image exists to give byte-preservation credit. Semantic completeness, citation entailment and pixel correctness remain null; no human/pixel proof was supplied.

### Export failure and audit artifacts

Both answered cases attempted export, and **both failed** with:

`Error: ENOENT: no such file or directory, open '/proc/self/fd/25/exports'`

Actual answers were persisted first and remain valid structural results; export errors are separate. **0 successful packages / 2 export attempts**. No repair, parent-directory workaround, fallback or export retry was performed. There are therefore no successful export package hashes to report. Each `A01-export.json` / `A37-export.json` error artifact is hashed instead. This remains an acceptance blocker even though the separately supplied Pi fullflow passed; that different run does not establish this evaluator's export success.

Each case retains claim, actual result/bundle/metrics, content-free transport/answer telemetry (HTTP 200, finish reason `stop`, bytes, durations and usage), and before/after health observations. `artifact-hashes.json` covers run records and was independently reverified. Experiment `audit.json` binds non-implementation artifacts including logs, pointers, claims, results/errors, telemetry and run hashes; SHA-256 `f9a60a60ffe32a03eaaf739c5e3f13a5dde71580d060a3bc758a39afbd2bcdf8`. The experiment protocol separately binds the implementation/dependencies and old evidence. Audit file excludes itself from its own manifest.

### Exact coverage and remaining work

This new bounded run is **4/4 predeclared attempts, 4/38 eligible case coverage, 4/40 target slots**; **34 eligible not attempted in this version**, **2 deferred genuine-conflict slots**. Across old and new experiments the same four IDs are exposed, not eight unique cases; old errors and unknown claims remain intact. No 38-case quality rate may be inferred from four regression cases, and 4/4 structural validity does not mean gate4 passed.

Remaining: separately authorize and freeze any broader inference protocol; investigate A25's false abstention and export-path failure outside this immutable run (no tuning against this gold); independently adjudicate facts/absence/entailment and figures/pixels; resolve conflict slots, original-photo legal provenance and durable storage; verify real portable rendering/export acceptance. Fresh generalization claims need a genuinely unexposed, independently reviewed set. No more inference is authorized by this completed bounded task.

## Evaluator export-root fix and separate OFFLINE recovery — 2026-09-06 12:57 UTC

**Addendum only: all historical results, claims, errors and statements above remain the record of their original runs. No inference was performed for this repair.** The original bounded run still has **0 successful packages / 2 export attempts**; the successes below belong only to a new offline recovery, not that run or its metrics.

### Cause and focused repair

The evaluator passed `join(root, run, "exports", g.id)` to `exportPortableDocument` without creating that nested directory. The production exporter intentionally accepts only an **existing safe output root**, so traversal failed at the missing `exports` component (`ENOENT` above). This was a harness precondition violation, not a reason to relax exporter safety.

`scripts/evaluate-answer-acceptance.ts` now calls its exported `exportEvaluationDocument` helper, which first invokes `ensureDirectorySafe(outputRoot)` and then the unchanged production exporter. Missing components are created privately (`0700` on POSIX); symlink components are rejected. Existing unsafe root permissions are not repaired or bypassed. A direct-execution guard permits importing the helper for offline tests without running evaluation/model preflight. Frozen implementation copies were **not patched**; future evaluation requires a new snapshot rather than modifying an old experiment.

`tests/evaluation-export.test.ts` adds three synthetic, offline regression tests:

- Missing nested root: the production API still rejects it; the harness creates each missing component with mode `0700`, exports a complete package, checks every manifest hash/length, and creates a separate package on a second export without overwriting the first.
- Symlink leaf and ancestor: both fail without writing through to the target.
- Existing group/other-writable root: fails closed and retains its original permissions.

Validation: `npm run check` passed (including the runner imported by the new tests). `node --experimental-strip-types --test tests/evaluation-export.test.ts tests/portable-export.test.ts` passed **13/13 tests, 0 failed, 0 skipped**. These are scoped checks, not a full-suite or quality claim. Only the evaluator, new test file and this documentation were edited; production exporter/path safety and the other worker's verifier/storage-recovery files were untouched.

### Separate recovery artifacts and exact outcome

New private sibling directory, outside all old experiment/run trees:

`/tmp/studio-answer-acceptance-OFFLINE-recovery-2026-09-06T12-56-56.668Z-938a8045-763a-4740-9ae7-8e2e6932c6e1`

- `report.json` SHA-256: `652e0d6596b5806b0446da071aad38191e2bd90295b452569abf3162c9b5b6e6`.
- `original-artifact-hashes.json`: pre-recovery SHA-256 inventory of **58,277 files** under `/tmp/studio-answer-acceptance`; a second full inventory was identical after export, including old freezes, implementations/dependencies, claims, results/errors, gold and runtime files. No catalog API was opened and no source blob was written.
- A01 package: `exports/A01/document-5f24d119-c9dc-496e-a295-a3194a3a71c4`.
- A37 package: `exports/A37/document-37984575-e628-4969-abb5-74d69d176a9e`.

**2/2 saved answered results exported successfully offline**, each with five files (`document.html`, `document.md`, `sources.json`, `evidence.json`, `manifest.json`) and an empty `assets/` directory. Both case output roots are `0700`. Each package manifest's file SHA-256 and byte length was checked; report rows retain all five package hashes, original result/error file hashes, serialized bundle/AnswerResult hashes and source revision hashes.

Before export, validation checked the known original freeze, experiment and audit hashes, every original audit/run-manifest entry, all frozen input hashes, and packaged/raw source bytes against the frozen catalog and acquisition manifest. `buildAnswerContext` validated each **original saved bundle** against the frozen snapshot (source revisions, text content/hash/locator/identity and image occurrence associations). Export used the saved document unchanged, not new retrieval or generation; exported source entries were checked against the saved bundle. This binds recovery to retained bytes, not an independent authenticity or semantic assessment.

A01/A37 contain only paragraphs. Recovery explicitly disabled image permission, supplied a blob provider that rejects all reads/writes, and verified empty exported asset directories: **zero corpus images copied or redistributed**. Packages remain local evaluation artifacts; existing license/NOTICE and underlying photo-rights limitations still apply. No model/service/health/network request, gold edit, private-KB operation, dependency installation, service change or commit occurred; `fetch` was replaced with a rejecting guard during recovery (**0 calls**).

This repairs the harness and demonstrates offline packaging of two saved text answers only. It does not erase the original export errors, retry A25, change abstention/figure metrics, establish interactive browser rendering, clear image licensing, or complete Gate4/independent semantic or pixel adjudication. Recovery artifacts are also under ephemeral `/tmp` and require separately approved durable retention before cleanup.

## Further never-dispatched subset — frozen, blocked before inference (2026-09-06 13:16 UTC)

**Gate4 remains incomplete. Zero new generation requests, answers or exports.** This is a further bounded subset, not full40 acceptance or guaranteed pristine heldout: frozen gold has been visible to the evaluator. All previous artifacts/results/claims, including the exposed A01/A31/A25/A37 regressions and original interrupted A31, remain unchanged.

Deterministic selection excludes all prior experiment claims, sorts frozen eligible IDs ascending within each requested category, and selects in category order:

| Category | Selected ID | Dispatch |
|---|---|---|
| First text-answerable | A02 | not attempted |
| First required-figure | A26 | not attempted |
| First corpus-relative no-answer | A32 | not attempted |
| First remaining hard-negative/false-premise | A03 | not attempted |

All four categories exist. A03 precedes remaining contradicted-premise A38; no category/case was invented. No claims were created for these IDs.

Experiment directory: `/tmp/studio-answer-acceptance/experiments/2026-09-06T13-14-51.638Z-6d225d5a-2823-4e8d-a6ac-947f75fa88f5`.

- `experiment.json` SHA-256: `c460d2a0510b471c602f072b93db905c6f37b58423c54dc2ba13dab9038f205e`.
- Before remote observations/inference, snapshot bound the unchanged original freeze, exact current implementation/runner (57 code/package hashes), 14,455 dependency hashes, 29 input/source/gold hashes, frozen catalog, prior results and all previous experiment files. Existing production changes were copied, not edited by this task; `changedCode` records differences from the original snapshot.
- Explicit profile: existing `http://127.0.0.1:18082/v1/chat/completions`, `qwen3.8-27b-q5`, current `grounded-answer-v2`, `llama.cpp`, `maxTokens=2048`, `enableThinking=false`, `reasoningBudgetTokens=0`, timeout `180000 ms`, ordered subset A02/A26/A32/A03, sequential, zero retries/fallback/repair. Identity remains operator-declared, not immutable backend attestation.
- Essential evaluator-only changes enforce deterministic never-claimed selection at snapshot time, record prior exclusions/exposure, and retain a post-case health observation even after a timeout (without permitting further inference). No source, prompt, retrieval or gold tuning. Existing safe export-root helper remains unchanged.
- Checkout `npm run check`, runner offline self-test, and scoped export tests **13/13** passed. Copied self-test and standalone strict runner/import compilation passed using `node node_modules/typescript/lib/tsc.js`; retained `offline-validation.log`. No dependency modification or installation.

### Exact blocker, not an inference error

After reading the complete remote skill and registry, read-only SSH, scheduled-task and remote health/model observations succeeded. Local health was `ok`, model ID matched, and slot 0 was **idle**. However, GPU 1 utilization was **73%**, GPU 0 **83%**, exceeding the registry's **40% contention-warning threshold**, with separate `torch310` Python workloads visible (GPU1 PID 2292; GPU0 PID 32824). Qwen process PID 35520 was observed on GPU1. These are point-in-time observations, not proof of workload ownership beyond the returned process paths.

The evaluator conservatively stopped on GPU contention under the user's busy-server stop condition. **This was not an observed Qwen slot-busy failure or missing endpoint.** No inference, waiting/recheck loop, service stop/start, configuration/tunnel change or private-KB access followed. No request had begun, so between/after-inference health checks were inapplicable. The frozen runner's health gate alone checks slot occupancy, not GPU utilization; do not bypass this operator-level contention block by blindly executing it later.

Artifacts under the experiment directory:

- `remote-status.log`: read-only SSH/task/remote health/models/GPU observations (Windows task text encoding is imperfect; health/model JSON is readable).
- `local-pre-inference-health.json`: content-free health/model/idle-slot observation; no slot prompts retained.
- `blocked-report.json`, SHA-256 `c0f84ab9d471bf9859d0717cfa5a09cb4a25783b50c3303778582e722a280a0c`.
- `audit.json`, SHA-256 `317d20f302b0e6eb8410dd8e1a91f1ec7447a21d64f7d9776c37580c542ef293`: hashes of non-implementation experiment artifacts, excluding itself; implementation/dependencies bound separately by experiment.

A final independent byte-hash check verified original/executing implementation/dependencies, frozen inputs, prior results and every previous experiment artifact unchanged. **Attempted/selected = 0/4; attempted/eligible = 0/38; target remains 40 with two deferred conflict slots.** Previous unique dispatched coverage remains four IDs, not eight. Correct abstention, false abstention and errors each have zero observations; abstention ratios are **0/0 → null**, not success. No actual AnswerResult or portable package path exists for this subset; original figure byte/hash/occurrence and exported asset checks have no selected-output denominator. Semantic completeness/entailment and pixel proof remain null; metadata or lexical proxies cannot supply them. No whole-delivery claim. Artifacts remain ephemeral/local, with existing image legal and durable-retention caveats unchanged.

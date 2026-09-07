# Public MindSpore real-source pilot — 2026-09-06

**A partial, evaluator-owned pilot, not the 40-case held-out acceptance set.** No retriever, parser, package, tests, or training data were edited by this evaluator. No scores, prompts, or retrieval settings were tuned against these questions. Public Markdown alone went to the already-running WeMM endpoint; gold answer text/locators never went to embedding or reranking. No reranker, vision model, generation model, or other remote model was used.

## Actual acquisition and exclusions

Discovery specification: `/tmp/acp-delegate/del_mtpknolt_iswk.out` (read in full). Source base: `https://raw.githubusercontent.com/mindspore-ai/docs/master/`. The mutable branch is **not** immutable commit provenance: commit resolution remains unavailable; exact downloaded SHA-256 bytes define the corpus revision.

- Attempted all 11 specified Markdown sources, five specified PNGs, LICENSE and NOTICE.
- Acquired **8/11 Markdown**, **5/5 specified PNGs**, **2/2 legal files**, plus the previously unresolved `tutorials/source_zh_cn/parallel/images/data_parallel.png`.
- **A-EN, R-ZH, R-EN** exhausted one initial attempt plus two retries each, with TLS/connection/timeouts. Never accepted different hashes. No further retries were made when packaging was rerun.
- Eight complete packaged documents imported successfully: A-ZH, P-ZH, P-EN, O-ZH, O-EN, C-ZH, C-EN, I-EN. **Zero importer failures** among these eight. Missing source documents were excluded whole, not stripped of figures or replaced by text-only versions.
- Therefore original questions **2, 5, 6, 7, 8, 9 were not scored**. Eight answerable questions remain (1, 3, 4, 10–14), including only **two image-required questions** (1 and 4). Do not call the result “14 questions passed.”

Acquisition uses direct TLS-verified curl, at most 3 attempts/path, 10-second connection timeout, 30-second transfer timeout, 20 MiB stdout buffer, no redirects and no shell interpolation. Logs retain each attempted request/error/elapsed time; cached exact bytes do not consume another request. First packaging conservatively excluded two documents for their website image URLs; before scoring, the generic packaging adapter was corrected to map the existing official `website-images/master/` prefix to the same repository-relative path, using original repository PNG bytes. This is not a question-dependent transform. No website endpoint was contacted.

Packaging preserves all text, captions, figure order and line count. Only the unsupported source-view SVG badge is replaced by a blank line; existing inline images become local content-addressed asset references. `acquisition.json` records each before/after substitution, original asset path/hash, raw and packaged hashes, and identity line mapping. An unsupported or unfetchable real figure excludes the whole document. No captions or query-oriented annotations are added.

## Gold and review limitations

`/tmp/studio-public-eval/gold.json` is evaluator-owned and outside `corpus/`. It retains all 14 original questions and discovery answer keys, plus inspected document IDs, supporting line locators and required original-image occurrence hashes. Chinese optimizer/index questions accept the inspected English translations as alternatives. English/scoped questions retain their explicit source restrictions. Translation families were not split into training and evaluation sets.

All **eight available full original documents** were reviewed before labeling no-answer proposals, including prose, code, logs and figure references (not external linked pages). Three probes were accepted only relative to this acquired corpus: universal 30% recompute throughput guarantee; exact GPU/driver/five-run deviation for the missing 72-layer comparison; required Kubernetes configuration. They are not claims of worldwide absence. The proposed pipeline-vs-optimizer throughput *figure* absence question was **deferred**, because pixels were not adjudicated. The two recomputation probes are especially weak after source exclusion and must not count as broad abstention coverage.

**No visual pixel adjudication was performed. Image gold is source-linkage-only, not visual truth.** It establishes which explicitly linked original occurrence was requested, not whether an unlabeled plot visually supports an answer. No generated answers were reviewed. nDCG and full answer completeness were not scored: no independently graded relevance set exists.

## Freeze and reproducible artifacts

Runner: `scripts/evaluate-public-corpus.ts`, Node v24.20.0 with experimental type stripping; no new dependency installation. All acquired data, gold, SQLite state, original blobs and results remain under `/tmp/studio-public-eval`, not checked into this repository.

Canonical valid records (SHA-256 of complete JSON bytes):

- Freeze: `4fad6e4cb5c9172d8c86f7698cf08cb3e7d92e9d6de307d6bac772fbd0742ae0`
- Result: `6aedf3d34e90403dd6b260cb7b558f6d3d50d3f2aaf16113d0abd51cd893a3a1`

Read them at `objects/<hash>.json`. They are exclusive-created, read-only content-addressed records, not tamper-proof WORM storage. Verify their filename hash before use. Freeze contains acquisition history, all raw/packaged file hashes, parsed snapshot/revisions, gold bytes hash and full gold, every `src/` file hash, runner/package/lockfile hashes, model identity, and fixed protocol. Raw originals, packaged files and the implementation snapshot are also retained as `objects/<sha256>` bytes. Source-hash → packaged-hash → parser revision → source ID → element/figure locator are resolvable from the freeze.

**Concurrent-write incident:** the first live run detected changed workspace source hashes after scoring (`implementationUnchanged: false`). Its result `a61caecdd9b6f627a450f24aa54b86895b8341250314eb9144304bc523848354` and freeze `897b582935dab251e3a5df4a553b4e118695e3afd0e243ed2414a5d87de82d73` are preserved but **invalid for frozen comparison**. No production files were changed by this evaluator. The valid repeat used a copied implementation under `/tmp/studio-public-eval/implementation`, froze its hashes before scoring, retained unchanged gold/corpus/protocol, and passed the post-run equality check. This is transparent recovery, not a fresh held-out set after results were exposed.

To repeat the exact valid scoring (uses retained runtime, reindexes the same public documents):

```bash
cd /tmp/studio-public-eval/implementation
node --experimental-strip-types scripts/evaluate-public-corpus.ts score       # offline lexical
node --experimental-strip-types scripts/evaluate-public-corpus.ts score --live # separately authorized WeMM
```

Runner phases are `acquire`, `freeze`, `score [--live]`. Required external inputs are `manifest.json` and `gold.json`; the content-addressed freeze embeds both acquisition manifest and gold, so neither relies on the discovery report surviving. Recreate inputs from those fields if needed. `freeze` imports complete documents and records code hashes; `score` rejects modified code/gold or catalog source revisions. For a fresh reproduction, preserve existing artifacts first, reconstruct raw/packaged files from freeze `content` hashes and use an empty runtime root at the same fixed path. The runtime uses path-derived source IDs. Run frozen implementation with `EVAL_GIT_COMMIT` set to the freeze's Git commit if refreezing outside Git. The checkout commit alone is insufficient: the source tree was uncommitted.

## Fixed scoring definitions

Runtime search returns at most 10 chunks, with at most five linked figures. Lexical and hybrid use the **same parsed snapshot**, current unmodified tokenization/chunking/RRF and no hints/reranker. Document rank deduplicates the returned chunk order; this is not a separate top-10-document search.

- Document Hit@10: any accepted supporting document occurs in the returned 10 chunks. With alternative translations this is a hit rate, **not recall of every alternative document**. Document MRR uses the first accepted deduplicated document.
- Evidence-locator Recall@10: fraction of accepted supporting documents with a returned chunk containing **any** annotated support line; macro average by question. This is a coarse support-location measure, **not complete evidence/answer coverage**. Multiple required facts may span chunks. Evidence MRR uses the first such chunk.
- Image occurrence Recall@5: required occurrences found among returned bundle images. Matching requires parsed source ID **and revision**, original blob SHA-256, and exact line locator. Same bytes from another document do not count.
- Required-image precision: correct required occurrences / all selected figures on the two image-required questions. Separately report strict request precision across all answerable questions, where unrequested images receive no credit; this is not a visual irrelevance judgment.
- Preservation: independently rehash actual returned blob bytes, not just compare two metadata strings.
- No-answer: evidence-compilation runtime has no semantic abstention path here. Returning generic relevant snippets is **not** an insufficient-evidence answer. Errors would be reported, not counted as correct abstentions.

## Valid measured results

| Metric | Lexical | Live WeMM hybrid |
| --- | ---: | ---: |
| Answerable attempted/successful | 8/8 | 8/8 |
| Document Hit@10 | 8/8 = 1.000 | 8/8 = 1.000 |
| Document MRR@10 | 0.9167 | 0.9375 |
| Evidence-locator macro Recall@10 | 0.8750 | 0.9375 |
| Evidence-locator MRR@10 | 0.7969 | 0.7813 |
| Required occurrence Recall@5 | 2/2 = 1.000 | 2/2 = 1.000 |
| Required-image precision | 2/4 = 0.500 | 2/5 = 0.400 |
| Strict image precision, all answerable | 2/11 = 0.1818 | 2/12 = 0.1667 |
| Returned original blob hash agreement, incl. no-answer | 16/16 | 16/16 |
| Explicit insufficient-evidence abstention | 0/3 | 0/3 |
| Query latency p50 / nearest-rank p95, 11 queries | 19 / 25 ms | 509 / 563 ms |

WeMM identity verified by the existing adapter on every successful response: `http://127.0.0.1:18083/embed`, `tencent/WeMM-Embedding-4B`, revision `a28b25c5d18cf71ec46b115e06ea79ab00ee4819`, dimension 512, empty query/document prefixes. The valid run made **22 successful requests, zero retries/errors**: one public-text health probe, ten indexing requests containing 99 document chunks, eleven query requests. The invalid first run also made 22 successful requests; **44 total model requests** were made during this task. Adapter requests have a stricter **30-second timeout** than the requested 120-second per-query ceiling; no unbounded retries. Indexing and health are not included in query latency.

Interpretation: coarse evidence recall rose, but evidence MRR and image precision fell. Perfect document hit rate on eight questions with few source families does not establish superiority or production readiness. The extra figures and lack of explicit abstention are real limitations, not erased by correct original hashes. Six excluded questions include the difficult recomputation image distinctions. The 11-document seed already lacks broad topic diversity; this eight-document successful subset is narrower still. Full held-out acceptance remains **not complete**.

## License and retention

Original sources: MindSpore Document, Copyright 2019–2020 Huawei Technologies Co., Ltd; Apache License 2.0. Original `LICENSE` and `NOTICE` are retained under `original/` and in content-addressed storage. Preserve both, attribution, and this modification notice when redistributing a corpus package. Packaging modifications are limited to source-view badge removal/local image localization described above. No trademark endorsement is implied. Large public corpus data are not automatically checked in. `/tmp` is ephemeral: copy the artifact directory to approved durable storage before cleanup if continued auditability is required.

## Exact source manifest

Paths are relative to the public base above. Missing Markdown hashes are expected discovery hashes, not newly verified downloads.

| ID | Repository path | Expected SHA-256 | Acquired |
| --- | --- | --- | --- |
| LICENSE | `LICENSE` | `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4` | yes |
| NOTICE | `NOTICE` | `bafe54b3285d4130aa5d9e8fef591b92aa7b27c02f9476f8fb1ec5e882abfeef` | yes |
| A-ZH | `docs/mindspore/source_zh_cn/features/overview.md` | `3b44365e6d5ce5b70b39205e3aaf5bb4e623141584c635c56e6e5f1ec5f55a54` | yes |
| A-EN | `docs/mindspore/source_en/features/overview.md` | `da866f642f37cb07c9d8b1ea46560c20e0d6cbd10d6f7155f8310b6a79636e5a` | no |
| R-ZH | `tutorials/source_zh_cn/parallel/recompute.md` | `11075579e91718f2e31535d5bc208ff18e96d9620764b42e79f9f9b467cd90e7` | no |
| R-EN | `tutorials/source_en/parallel/recompute.md` | `d02b512194f2a33e456a23c6a2e493fabb330b0e2c6a69c295100917e04c9cfe` | no |
| P-ZH | `tutorials/source_zh_cn/parallel/pipeline_parallel.md` | `f2e320fb61d124bf46e93caa79132b4a4cd4b5ad65c06dd9cab046524b0aed52` | yes |
| P-EN | `tutorials/source_en/parallel/pipeline_parallel.md` | `9ccf6da829b44ad38423d08eb2676354bc2d91180cf7585c0c2aa24b6d25eeb9` | yes |
| O-ZH | `tutorials/source_zh_cn/parallel/optimizer_parallel.md` | `8a6f357581eb9d301f582cdfdbc199b9c5bf9578d9c2d7f07ded02aa6013a0c0` | yes |
| O-EN | `tutorials/source_en/parallel/optimizer_parallel.md` | `6b471f956398b33475e5d4af9e31f16dc2977b3070dd11d357d85a5fca5fb78d` | yes |
| C-ZH | `tutorials/source_zh_cn/parallel/comm_fusion.md` | `6673be262f4fe6b1ccbceb130a4a0584083dde377f9ea5af9cf0adc127100be4` | yes |
| C-EN | `tutorials/source_en/parallel/comm_fusion.md` | `3de73a83e19d13e51e31ab270fdae074aaa5bfa4e1268491e0744ecbd971bb43` | yes |
| I-EN | `tutorials/source_en/beginner/introduction.md` | `b42aec7e306be0273efa3a85b310b99a44d0e92d40ee5d996e84832fb6b12420` | yes |
| ARCH-ZH | `docs/mindspore/source_zh_cn/features/images/arch_zh.png` | `53b4eb88e08389c34f0d002643a29499a699039ed4eac8de7d86ecb11c7a5d1c` | yes |
| ARCH-EN | `docs/mindspore/source_en/features/images/arch_en.png` | `d703dadbb662b19a18a83a21b4808aeedf8d6967f2b9ee4b6053804738e5b7ac` | yes |
| RECOMP-GRAPH | `tutorials/source_zh_cn/parallel/images/recompute_image_0_zh.png` | `6c94efdd0c54ee641e753ba84faa143fdad480fd23968e4431877456faa0b033` | yes |
| RECOMP-MEM | `tutorials/source_zh_cn/parallel/images/recompute_image_1_zh.png` | `b3366fd371b37f8b14fd8206b57c4cd863709270e8651a23b9d36569efe06402` | yes |
| ASCEND-STACK | `tutorials/source_en/beginner/images/introduction1.png` | `e86afc7f2d2f08e6f2d9584f82c45351d430d540665780c87ce38bf38e8eede9` | yes |

Additional original: `tutorials/source_zh_cn/parallel/images/data_parallel.png`, SHA-256 `7f40a8c00ea87753646681934205de572af8b6bdda17ba8a70c89f9de78b9b9a`.

## Paired per-question results

Evidence values use the coarse locator definition above. Full queries, answer keys and image locators remain in evaluator gold, not indexed corpus.

| Question | Lexical evidence recall / MRR | Hybrid evidence recall / MRR |
| --- | --- | --- |
| 1 | 1.0000 / 0.2500 | 1.0000 / 0.5000 |
| 2 | excluded | excluded |
| 3 | 1.0000 / 1.0000 | 1.0000 / 1.0000 |
| 4 | 1.0000 / 1.0000 | 1.0000 / 1.0000 |
| 5 | excluded | excluded |
| 6 | excluded | excluded |
| 7 | excluded | excluded |
| 8 | excluded | excluded |
| 9 | excluded | excluded |
| 10 | 1.0000 / 0.1250 | 1.0000 / 0.2500 |
| 11 | 1.0000 / 1.0000 | 1.0000 / 1.0000 |
| 12 | 0.5000 / 1.0000 | 0.5000 / 1.0000 |
| 13 | 1.0000 / 1.0000 | 1.0000 / 1.0000 |
| 14 | 0.5000 / 1.0000 | 1.0000 / 0.5000 |
| 15 (no-answer) | no abstention | no abstention |
| 16 (no-answer) | no abstention | no abstention |
| 17 (no-answer) | no abstention | no abstention |

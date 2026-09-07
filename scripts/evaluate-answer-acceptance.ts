/** Independent gate4 evaluator. See docs/answer-acceptance-evaluation.md.
 * No acquisition, model defaults, embeddings, retries, or production tuning.
 * freeze | lexical | score --approve-model-egress | self-test
 */
import { readFile, writeFile, mkdir, readdir, cp } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { KnowledgeRuntime } from "../src/application/knowledge-runtime.ts";
import { SqliteCatalog } from "../src/adapters/storage/sqlite-catalog.ts";
import { buildAnswerContext, emptyAnswer } from "../src/application/answer-context.ts";
import { answerGenerationFromEnv, type AnswerGenerationProfile } from "../src/adapters/models/answer-model-options.ts";
import type { ModelTelemetryEvent } from "../src/adapters/models/http-embedding.ts";
import { generateAnswer } from "../src/adapters/models/grounded-answer.ts";
import { exportPortableDocument } from "../src/adapters/export/portable-export.ts";
import { ensureDirectorySafe } from "../src/core/path-safety.ts";
import type { AnswerResult, FigurePolicy } from "../src/domain/answer.ts";
import type { EvidenceBundle, TextEvidence } from "../src/domain/evidence.ts";
import type { CapturedDocument } from "../src/domain/retrieval.ts";
const root = "/tmp/studio-answer-acceptance";
const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const load = async <T>(p: string): Promise<T> => JSON.parse(await readFile(join(root, p), "utf8")) as T;
async function save(p: string, value: unknown) {
  await mkdir(dirname(join(root, p)), { recursive: true });
  await writeFile(join(root, p), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}
async function archive(bytes: Uint8Array) {
  const path = join(root,"objects",digest(bytes));
  try { await writeFile(path,bytes,{flag:"wx",mode:0o444}); }
  catch(e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    assert.equal(digest(await readFile(path)),digest(bytes),"Object hash collision");
  }
}
async function files(base: string, rel = ""): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of (await readdir(join(base, rel), { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const p = join(rel, e.name);
    if (e.isDirectory()) Object.assign(out, await files(base, p));
    else if (e.isFile()) out[p] = digest(await readFile(join(base, p)));
    else throw new Error(`Nonregular freeze input: ${p}`);
  }
  return out;
}
async function code(base: string) {
  const out = await files(join(base, "src"));
  const result: Record<string, string> = Object.fromEntries(Object.entries(out).map(([p,h]) => [join("src",p),h]));
  for (const p of ["package.json", "package-lock.json", "scripts/evaluate-answer-acceptance.ts"])
    result[p] = digest(await readFile(join(base,p)));
  return result;
}
interface Question { id: string; question: string | null; figurePolicy: FigurePolicy }
interface Support { document: string; start: number; end: number }
interface Gold { id: string; category: string; expected: "answered" | "insufficient-evidence" | "deferred"; facts?: {id: string; description: string; support: Support[]}[]; requiredFigures?: {document: string; line: number; sha256: string}[] }
interface Manifest { documents: { id: string; path: string }[] }
interface Frozen {
  schema: 1; at: string; node: string; code: Record<string,string>; dependencies: Record<string,string>;
  inputs: Record<string,string>; snapshot: { epoch: number; documents: CapturedDocument[] };
  imported: {id: string; document: CapturedDocument}[]; eligible: number; target: number;
}
async function inputs() {
  const out: Record<string,string> = {};
  for (const dir of ["original", "corpus"]) for (const [p,h] of Object.entries(await files(join(root,dir)))) out[join(dir,p)] = h;
  for (const p of ["manifest.json", "questions.json", "gold.json", "design.json", "prepare.py"])
    out[p] = digest(await readFile(join(root,p)));
  return out;
}
async function verify(f: Frozen, implementation = checkout) {
  assert.equal(process.version, f.node, "Node version drift");
  assert.deepEqual(await code(implementation), f.code, "Implementation drift");
  assert.deepEqual(await files(join(implementation,"node_modules")), f.dependencies, "Dependency drift");
  assert.deepEqual(await inputs(), f.inputs, "Corpus/gold/protocol drift");
  const snap = await SqliteCatalog.use(join(root,"runtime"), async c => c.snapshot());
  assert.deepEqual({epoch:snap.epoch,documents:snap.documents}, f.snapshot, "Catalog drift");
}
interface Experiment {
  parentFreeze: string; at: string; implementation: string; node: string;
  code: Record<string,string>; dependencies: Record<string,string>;
  changedCode: string[]; priorResults: Record<string,string>;
  priorExperiments: Record<string, Record<string,string>>;
  protocol: { generation: AnswerGenerationProfile | null; exposure: "evaluator-exposed bounded subset, not pristine holdout"; selection: { priorClaimed: string[]; categories: string[] }; stopOnTimeout: true; timeoutMs: number; subset: string[]; model: {endpoint:string; model:string; identityBasis:string}; retries: 0 };
}
function timeoutSetting(value = process.env.ANSWER_TIMEOUT_MS) {
  if (!value || !/^\d+$/.test(value)) throw new Error("Explicit ANSWER_TIMEOUT_MS integer 1..180000 required");
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms < 1 || ms > 180000) throw new Error("ANSWER_TIMEOUT_MS outside 1..180000");
  return ms;
}
function subsetSetting(gold: Gold[], value = process.env.ANSWER_CASE_IDS) {
  const ids = value?.split(",") ?? [];
  if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !gold.some(g => g.id === id && g.expected !== "deferred"))) throw new Error("ANSWER_CASE_IDS must be unique eligible frozen IDs");
  return ids;
}
async function experimentVerification(e: Experiment, f: Frozen) {
  assert.equal(digest(await readFile(join(root,"freeze.json"))),e.parentFreeze);
  await verify(f,join(root,"implementation")); // original freeze/code remain unchanged
  assert.equal(checkout,join(root,e.implementation),"Execute copied experiment runner only");
  assert.deepEqual(await code(checkout),e.code,"Executing implementation drift");
  assert.deepEqual(await files(join(checkout,"node_modules")),e.dependencies,"Executing dependency drift");
  assert.equal(process.version,e.node);
  assert.deepEqual(await files(join(root,"runs")),e.priorResults,"Prior result drift");
  for (const [rel,hashes] of Object.entries(e.priorExperiments)) assert.deepEqual(await files(join(root,rel)),hashes,"Prior experiment drift");
}
async function idleService() {
  const get = async (path: string) => {
    const response = await fetch(`http://127.0.0.1:18082/${path}`, {signal:AbortSignal.timeout(5000)});
    assert.ok(response.ok, `Service ${path} HTTP ${response.status}`);
    return await response.json();
  };
  const health = await get("health") as {status?:string};
  const models = await get("v1/models") as {data?:{id:string}[]};
  const slots = await get("slots") as {id:number;is_processing:boolean}[];
  // Do not persist slot prompts, caches, or unrelated request content.
  const observation = {at:new Date().toISOString(),health:health.status,modelIds:models.data?.map(m=>m.id),slots:slots.map(s=>({id:s.id,is_processing:s.is_processing}))};
  assert.equal(health.status,"ok");
  assert.ok(observation.modelIds?.includes("qwen3.8-27b-q5"));
  assert.ok(slots.length > 0 && slots.every(s=>s.is_processing===false),"Service slots not idle; no dispatch");
  return observation;
}
function verifyProtocol(e: Experiment, timeoutMs: number, subset: string[], generation: AnswerGenerationProfile | undefined) {
  assert.equal(timeoutMs,e.protocol.timeoutMs);
  assert.deepEqual(subset,e.protocol.subset,"Exact ordered predeclared subset required");
  assert.deepEqual(generation ?? null,e.protocol.generation,"Generation profile drift before egress");
}
const ratio = (numerator: number, denominator: number) => ({ numerator, denominator, value: denominator ? numerator/denominator : null });
type Actual = AnswerResult | ReturnType<typeof emptyAnswer>;
function outcome(expected: Gold["expected"], result?: Actual, error?: string) {
  if (error !== undefined) return { status: "error", abstained: null, correctAbstention: false, falseAbstention: false, error };
  if (!result) throw new Error("Missing actual result");
  const abstained = result.status === "insufficient-evidence";
  return {status: result.status, abstained, correctAbstention: expected === "insufficient-evidence" && abstained, falseAbstention: expected === "answered" && abstained};
}
function measure(g: Gold, result: Actual, bundle: EvidenceBundle | null, f: Frozen) {
  const texts = new Map(bundle?.texts.map(t => [t.id,t]) ?? []);
  const sourceIds = new Map(f.imported.map(i => [i.id,i.document.id]));
  const matches = (t: TextEvidence, s: Support) => t.sourceId === sourceIds.get(s.document) && t.locator.kind === "lines" && t.locator.start <= s.end && t.locator.end >= s.start;
  const paragraphs = result.document?.blocks.filter(b => b.kind === "paragraph") ?? [];
  const refs = paragraphs.flatMap(p => p.evidenceIds);
  const referenced = refs.flatMap(id => texts.has(id) ? [texts.get(id)!] : []);
  const facts = (g.facts ?? []).map(fact => ({id:fact.id,
    retrievedLocatorHit: fact.support.some(s => [...texts.values()].some(t => matches(t,s))),
    citedLocatorHit: fact.support.some(s => referenced.some(t => matches(t,s))),
    semanticCompleteness: null,
  }));
  const goldFigures = (g.requiredFigures ?? []).map(want => {
    const doc = f.imported.find(i => i.id === want.document)?.document;
    const image = doc?.images.find(i => i.blobHash === want.sha256 && i.locator.kind === "lines" && i.locator.start === want.line);
    if (!doc || !image) throw new Error("Gold figure not captured in frozen catalog");
    return `figure_${digest(doc.id + image.id)}`;
  });
  const selected = result.document?.blocks.filter(b => b.kind === "figure").map(b => b.occurrenceId) ?? [];
  const correct = selected.filter(id => goldFigures.includes(id)).length;
  return { facts,
    referenceIntegrity: ratio(refs.filter(id => texts.has(id)).length, refs.length),
    citedLocatorCompletenessProxy: ratio(facts.filter(x => x.citedLocatorHit).length,facts.length),
    selectedFigureRecall: ratio(goldFigures.filter(id => selected.includes(id)).length,goldFigures.length),
    strictRequestedFigurePrecision: ratio(correct,selected.length),
    selectedFigureIds: selected, requiredFigureIds: goldFigures,
    modelSelfJudgment: result.assessment, // Not an independent completeness metric.
    semanticCompleteness: null, citationEntailment: null, pixelCorrectness: null,
  };
}
/** Evaluator-owned directories only; production export still requires a safe existing root. */
export async function exportEvaluationDocument(
  outputRoot: string,
  ...args: Tail<Parameters<typeof exportPortableDocument>>
): Promise<string> {
  await ensureDirectorySafe(outputRoot);
  return exportPortableDocument(outputRoot, ...args);
}
type Tail<T extends unknown[]> = T extends [unknown, ...infer Rest] ? Rest : never;

async function main() {
  const phase = process.argv[2];
  if (phase === "self-test") {
    assert.equal(timeoutSetting("180000"),180000);
    assert.equal(answerGenerationFromEnv({}),undefined);
    const profile = answerGenerationFromEnv({PI_KS_V2_GENERATE_PROTOCOL:"llama.cpp",PI_KS_V2_GENERATE_MAX_TOKENS:"2048",PI_KS_V2_GENERATE_ENABLE_THINKING:"false",PI_KS_V2_GENERATE_REASONING_BUDGET_TOKENS:"0"});
    assert.deepEqual(profile,{protocol:"llama.cpp",maxTokens:2048,enableThinking:false,reasoningBudgetTokens:0});
    const protocolFixture = {protocol:{timeoutMs:180000,subset:["A01"],generation:profile}} as Experiment;
    verifyProtocol(protocolFixture,180000,["A01"],profile);
    assert.throws(()=>verifyProtocol(protocolFixture,180000,["A01"],undefined));
    assert.throws(()=>verifyProtocol(protocolFixture,180000,["A31"],profile));
    for (const invalid of ["0","180001","1.5","abc",""]) assert.throws(()=>timeoutSetting(invalid));
    assert.deepEqual(subsetSetting([{id:"A01",category:"answerable",expected:"answered"}],"A01"),["A01"]);
    assert.throws(()=>subsetSetting([],"A39"));
    const a = emptyAnswer("validation only");
    assert.equal(outcome("answered",a).falseAbstention,true);
    assert.equal(outcome("insufficient-evidence",a).correctAbstention,true);
    assert.equal(outcome("insufficient-evidence",undefined,"timeout").abstained,null);
    assert.equal(outcome("insufficient-evidence",undefined,"timeout").correctAbstention,false);
    assert.equal(ratio(0,0).value,null);
    // Transport-boundary injection exercises actual adapter error path without HTTP.
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls++; throw new Error("injected runner transport failure"); }) as typeof fetch;
    try {
      const f = await load<Frozen>("freeze.json");
      const runtime = new KnowledgeRuntime(join(root,"runtime"));
      const {bundle} = await runtime.search("Pillow image bands",10);
      const candidates = buildAnswerContext(bundle,f.snapshot);
      await assert.rejects(generateAnswer({endpoint:"http://127.0.0.1:1/v1/chat/completions",model:"runner-validation-only",approved:true,timeoutMs:1000},bundle,"Pillow image bands","Validation","none",candidates));
      assert.equal(calls,1);
    } finally { globalThis.fetch = original; }
    console.log("Runner validation passed: actual insufficiency, error accounting, zero-denominator, real adapter injected transport failure; no model inference.");
    return;
  }
  if (phase === "freeze") {
    // Copy first: other agents may edit checkout during this evaluation.
    const dest = join(root,"implementation");
    await mkdir(dest); // Refuse replacement of an existing freeze.
    const before = await code(checkout);
    for (const p of ["src","package.json","package-lock.json","scripts/evaluate-answer-acceptance.ts","node_modules"])
      await cp(join(checkout,p),join(dest,p),{recursive:true,dereference:true});
    assert.deepEqual(await code(checkout),before,"Checkout changed during copy; do not score");
    assert.deepEqual(await code(dest),before);
    const manifest = await load<Manifest>("manifest.json");
    const questions = await load<Question[]>("questions.json");
    const gold = await load<Gold[]>("gold.json");
    assert.equal(questions.length,40); assert.equal(gold.length,40);
    assert.equal(new Set(questions.map(q=>q.id)).size,40);
    assert.deepEqual(questions.map(q=>q.id),gold.map(g=>g.id));
    const {KnowledgeRuntime: FrozenRuntime} = await import(join(dest,"src/application/knowledge-runtime.ts"));
    const {SqliteCatalog: FrozenCatalog} = await import(join(dest,"src/adapters/storage/sqlite-catalog.ts"));
    const runtime = new FrozenRuntime(join(root,"runtime"));
    const imported = [];
    for (const d of manifest.documents) imported.push({id:d.id,document:await runtime.ingest(join(root,"corpus"),join(root,"corpus",d.path))});
    const snapshot = await FrozenCatalog.use(join(root,"runtime"),async (c: SqliteCatalog)=>c.snapshot());
    const f: Frozen = {schema:1,at:new Date().toISOString(),node:process.version,code:before,dependencies:await files(join(dest,"node_modules")),inputs:await inputs(),snapshot:{epoch:snapshot.epoch,documents:snapshot.documents},imported,eligible:gold.filter(g=>g.expected!=="deferred").length,target:40};
    // Validate line gold and figure occurrence identity before any retrieval/scoring.
    for (const g of gold.filter(g=>g.expected!=="deferred")) {
      assert.ok(questions.find(q=>q.id===g.id)?.question);
      for (const fact of g.facts ?? []) for (const s of fact.support) {
        const doc = manifest.documents.find(d=>d.id===s.document); assert.ok(doc);
        const lines = (await readFile(join(root,"corpus",doc.path),"utf8")).split("\n");
        assert.ok(s.start>=1 && s.end>=s.start && s.end<lines.length);
      }
      measure(g,emptyAnswer("freeze structural check"),null,f);
    }
    const bytes = JSON.stringify(f,null,2)+"\n";
    await mkdir(join(root,"objects"),{recursive:true});
    // Archive all bytes needed for audit, not only digest strings.
    for (const p of Object.keys(f.inputs)) await archive(await readFile(join(root,p)));
    for (const p of Object.keys(f.code)) await archive(await readFile(join(dest,p)));
    await writeFile(join(root,"objects",digest(bytes)+".json"),bytes,{flag:"wx",mode:0o444});
    await save("freeze.json",f); await save("freeze-pointer.json",{sha256:digest(bytes)});
    console.log(JSON.stringify({freeze:join(root,"objects",digest(bytes)+".json"),eligible:f.eligible,target:40}));
    return;
  }
  if (phase === "snapshot-experiment") {
    const f = await load<Frozen>("freeze.json");
    const pointer = await load<{sha256:string}>("freeze-pointer.json");
    assert.equal(digest(await readFile(join(root,"freeze.json"))),pointer.sha256);
    await verify(f,join(root,"implementation"));
    const gold = await load<Gold[]>("gold.json");
    const subset = subsetSetting(gold), timeoutMs = timeoutSetting();
    assert.equal(process.env.ANSWER_ENDPOINT,"http://127.0.0.1:18082/v1/chat/completions");
    assert.equal(process.env.ANSWER_MODEL,"qwen3.8-27b-q5");
    const generation = answerGenerationFromEnv(process.env);
    const priorClaimed = new Set<string>();
    for (const entry of await readdir(join(root,"experiments"))) {
      try { for (const claim of await readdir(join(root,"experiments",entry,"claims"))) priorClaimed.add(claim.replace(/\.json$/, "")); }
      catch(e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    const categories = ["answerable", "figure-linkage", "missing-information", "hardnegative|contradicted-premise"];
    const selected = categories.flatMap(category => {
      const candidate = [...gold].sort((a,b)=>a.id.localeCompare(b.id)).find(g=>g.expected!=="deferred" && !priorClaimed.has(g.id) && category.split("|").includes(g.category));
      return candidate ? [candidate.id] : [];
    });
    assert.deepEqual(subset,selected,"Must select first never-claimed eligible ID per category");
    const priorExperiments: Record<string,Record<string,string>> = {};
    for (const entry of await readdir(join(root,"experiments"))) priorExperiments[`experiments/${entry}`] = await files(join(root,"experiments",entry));
    const rel = `experiments/${new Date().toISOString().replaceAll(":","-")}-${randomUUID()}`;
    const implementation = join(rel,"implementation");
    await mkdir(join(root,implementation),{recursive:true});
    const before = await code(checkout);
    for (const p of ["src","package.json","package-lock.json","scripts/evaluate-answer-acceptance.ts","node_modules"])
      await cp(join(checkout,p),join(root,implementation,p),{recursive:true,dereference:true});
    assert.deepEqual(await code(checkout),before,"Source drift during copy");
    assert.deepEqual(await code(join(root,implementation)),before);
    const e: Experiment = {parentFreeze:pointer.sha256,at:new Date().toISOString(),implementation,node:process.version,
      code:before,dependencies:await files(join(root,implementation,"node_modules")),
      changedCode:[...new Set([...Object.keys(f.code),...Object.keys(before)])].filter(p=>f.code[p]!==before[p]),
      priorResults:await files(join(root,"runs")),priorExperiments,
      protocol:{generation:generation ?? null,exposure:"evaluator-exposed bounded subset, not pristine holdout",selection:{priorClaimed:[...priorClaimed].sort(),categories},stopOnTimeout:true,timeoutMs,subset,model:{endpoint:process.env.ANSWER_ENDPOINT!,model:process.env.ANSWER_MODEL!,identityBasis:"operator-declared ID; no immutable backend attestation"},retries:0}};
    await save(`${rel}/experiment.json`,e);
    await save(`${rel}/experiment-pointer.json`,{sha256:digest(await readFile(join(root,rel,"experiment.json")))});
    console.log(join(root,rel)); return;
  }
  if (!["lexical","score"].includes(phase ?? "")) throw new Error("Use freeze | snapshot-experiment | lexical | score --approve-model-egress | self-test");
  const pointer = await load<{sha256:string}>("freeze-pointer.json");
  assert.equal(digest(await readFile(join(root,"freeze.json"))),pointer.sha256,"Freeze hash mismatch");
  const f = await load<Frozen>("freeze.json");
  const questions = await load<Question[]>("questions.json"), gold = await load<Gold[]>("gold.json");
  const expRel = process.env.ANSWER_EXPERIMENT;
  let experiment: Experiment | null = null, experimentHash: string | null = null;
  if (expRel) {
    assert.match(expRel,/^experiments\/[A-Za-z0-9.-]+$/);
    experiment = await load<Experiment>(`${expRel}/experiment.json`);
    experimentHash = (await load<{sha256:string}>(`${expRel}/experiment-pointer.json`)).sha256;
    assert.equal(digest(await readFile(join(root,expRel,"experiment.json"))),experimentHash);
    await experimentVerification(experiment,f);
  } else { assert.equal(checkout,join(root,"implementation")); await verify(f); }
  const timeoutMs = timeoutSetting();
  const generation = answerGenerationFromEnv(process.env);
  const subset = subsetSetting(gold);
  const model = phase === "score" ? {endpoint:process.env.ANSWER_ENDPOINT,model:process.env.ANSWER_MODEL,identityBasis:"operator-declared ID; no immutable backend attestation"} : null;
  if (phase === "score" && (!experiment || !process.argv.includes("--approve-model-egress") || !model?.endpoint || !model.model)) throw new Error("Frozen experiment, explicit egress flag and endpoint/model required");
  if (experiment) {
    verifyProtocol(experiment,timeoutMs,subset,generation);
    if (model) assert.deepEqual(model,experiment.protocol.model);
  }
  const run = `${expRel ?? ""}${expRel ? "/" : ""}runs/${new Date().toISOString().replaceAll(":","-")}-${randomUUID()}`;
  // Claims persist before dispatch. Interrupted/failed cases are never silently retried.
  if (phase === "score") for (const id of subset) {
    const claim = join(root,expRel!,"claims",`${id}.json`);
    try { await readFile(claim); throw new Error(`Case ${id} already claimed; preserve its result/error/in-flight state, no automatic retry`); }
    catch(e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  await save(`${run}/preflight.json`,{freeze:pointer.sha256,experimentHash,phase,model,generation:generation ?? null,timeoutMs,subset,retries:0,at:new Date().toISOString()});
  const runtime = new KnowledgeRuntime(join(root,"runtime"));
  const rows: {id:string; expected:Gold["expected"]; status:string; falseAbstention?:boolean; correctAbstention?:boolean}[] = [];
  let stopReason: string | null = null;
  const notAttempted: string[] = [];
  for (const id of subset) {
    const g = gold.find(g=>g.id===id)!;
    if (phase === "score" && !stopReason) {
      try { await save(`${run}/${id}-health-before.json`,await idleService()); }
      catch(e) { stopReason = `Health/idle gate failed: ${String(e)}`; }
    }
    if (stopReason) {
      notAttempted.push(id);
      await save(`${run}/${id}-not-attempted.json`,{id,status:"not-attempted",reason:stopReason});
      continue;
    }
    if (phase === "score") await save(`${expRel}/claims/${id}.json`,{run,id,experimentHash,at:new Date().toISOString(),state:"dispatch claimed; consult run result, absent result means interrupted/unknown, not untested"});
    const q = questions.find(q=>q.id===g.id)!;
    const started = Date.now(); let stage = "retrieval";
    const telemetry: Readonly<ModelTelemetryEvent>[] = [];
    let bundle: EvidenceBundle | null = null;
    try {
      let actual: Actual | undefined;
      try { bundle = (await runtime.search(q.question!,10)).bundle; }
      catch (e) { if (e instanceof Error && e.message === "No relevant evidence found") actual = emptyAnswer(q.question!); else throw e; }
      if (phase === "lexical") {
        await save(`${run}/${g.id}.json`,{id:g.id,status:"retrieval-only",bundle,answerResult:null,metrics:null,ms:Date.now()-started});
        rows.push({id:g.id,expected:g.expected,status:"retrieval-only"}); continue;
      }
      stage = "answer-model";
      if (bundle) actual = await generateAnswer({endpoint:model!.endpoint!,model:model!.model!,approved:true,timeoutMs,...(generation ? {generation} : {}),...(process.env.ANSWER_API_KEY ? {apiKey:process.env.ANSWER_API_KEY} : {})},bundle,q.question!,q.question!,q.figurePolicy,buildAnswerContext(bundle,f.snapshot),event=>{telemetry.push(structuredClone(event));});
      assert.ok(actual);
      const metrics = measure(g,actual,bundle,f);
      const preservation = [];
      for (const id of metrics.selectedFigureIds) {
        const image = bundle?.images.find(i=>i.id===id); assert.ok(image);
        preservation.push({id,blobHash:image.blobHash,byteHashAgreement:digest(await runtime.blobs.get(image.blobHash))===image.blobHash});
      }
      // Persist answer before export; export failure must not erase model outcome.
      const row = {id:g.id,expected:g.expected,...outcome(g.expected,actual)};
      await save(`${run}/${g.id}.json`,{...row,actual,bundle,metrics,preservation,ms:Date.now()-started}); rows.push(row);
      if (actual.status === "answered" && bundle) {
        try {
          const path = await exportEvaluationDocument(join(root,run,"exports",g.id),bundle,actual.document,{documentContent:true,images:true,excerpts:true},runtime.blobs);
          await save(`${run}/${g.id}-export.json`,{status:"exported",path,hashes:await files(path)});
        } catch(e) { await save(`${run}/${g.id}-export.json`,{status:"error",error:String(e)}); }
      }
    } catch(e) {
      if (/timed out|timeout|TimeoutError/i.test(String(e))) stopReason = `Timeout in ${id}; remaining dispatch prohibited`;
      const row = {id:g.id,expected:g.expected,...outcome(g.expected,undefined,String(e))}; rows.push(row);
      await save(`${run}/${g.id}.json`,{...row,stage,bundle,ms:Date.now()-started});
    } finally {
      await save(`${run}/${g.id}-telemetry.json`,telemetry);
    }
    if (phase === "score") {
      try { await save(`${run}/${id}-health-after.json`,await idleService()); }
      catch(e) {
        await save(`${run}/${id}-health-after-error.json`,{at:new Date().toISOString(),error:String(e)});
        stopReason ??= `Post-case health/idle gate failed: ${String(e)}`;
      }
    }
  }
  let unchanged = true; let drift: string | null = null;
  try { if (experiment) await experimentVerification(experiment,f); else await verify(f); } catch(e) {unchanged=false;drift=String(e);}
  const answeredGold = rows.filter(r=>r.expected==="answered"), missingGold=rows.filter(r=>r.expected==="insufficient-evidence");
  await save(`${run}/summary.json`,{freeze:pointer.sha256,experimentHash,phase,model,timeoutMs,subset,generation:generation ?? null,notAttempted,stopReason,unchanged,drift,target:40,eligible:f.eligible,notAttemptedThisBatch:f.eligible-rows.length,attempted:rows.length,errors:rows.filter(r=>r.status==="error").length,
    falseAbstention:phase==="score"?ratio(answeredGold.filter(r=>r.falseAbstention).length,answeredGold.length):null,
    correctAbstention:phase==="score"?ratio(missingGold.filter(r=>r.correctAbstention).length,missingGold.length):null,
    successfulAnswerResults:rows.filter(r=>["answered","insufficient-evidence"].includes(r.status)).length,
    gate4:"NOT COMPLETE: deferred cases, independent human/pixel gold and inference quality must be reviewed",rows});
  await save(`${run}/artifact-hashes.json`,await files(join(root,run)));
  console.log(join(root,run,"summary.json"));
  if (!unchanged) process.exitCode=1;
}
// Importing the offline export helper must not execute evaluation or model preflight.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

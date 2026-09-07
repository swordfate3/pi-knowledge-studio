import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { generateAnswer } from "../src/adapters/models/grounded-answer.ts";
import type { AnswerWireResponse, HostFigureCandidate } from "../src/domain/answer.ts";
import type { EvidenceBundle } from "../src/domain/evidence.ts";
import { OCR_RECIPE } from "../src/domain/ocr.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const question = "For the Alder relay, give both the reset interval and standby draw.";
const title = "Relay notes";
const options = { endpoint: "https://answer.invalid/completions", model: "authored-fixture", approved: true };
function fixture(): EvidenceBundle {
  return {
    schemaVersion: 1, id: "bundle", snapshotId: "snapshot",
    sources: [{ id: "source", label: "Authored relay manual", revisionHash: hash("manual") }],
    texts: ["The Alder relay resets after 18 seconds. Wiring overview follows.", "Alder standby draw is 4 mA.", "Revision B says the reset interval is 24 seconds."].map((text, i) => ({ id: `text${i}`, sourceId: "source", elementId: `element${i}`, locator: { kind: "page", page: i + 1 }, text, textHash: hash(text), start: 0, end: text.length })),
    // Same bytes, different occurrences and linkage.
    images: [0, 1].map(i => ({ id: `image${i}`, sourceId: "source", locator: { kind: "page", page: i + 1 }, blobHash: hash("same-image-bytes"), originKind: "embedded_original" })),
  };
}
function candidates(): HostFigureCandidate[] {
  return [{ occurrenceId: "image0", linkedTextIds: ["text0"], caption: "Wiring overview" }, { occurrenceId: "image1", linkedTextIds: ["text1"], caption: "Standby table" }];
}
function answer(): AnswerWireResponse {
  return { wireVersion: "grounded-answer-v2", status: "answered", requirements: [
    { id: "reset", requirement: "Reset interval", status: "supported", evidenceIds: ["text0"] },
    { id: "draw", requirement: "Standby draw", status: "supported", evidenceIds: ["text1"] },
  ], figures: [], paragraphs: [
    { text: "Reset takes 18 seconds.", evidenceIds: ["text0"], requirementIds: ["reset"] },
    { text: "Standby draw is 4 mA.", evidenceIds: ["text1"], requirementIds: ["draw"] },
  ] };
}
function illustrated(): AnswerWireResponse {
  const result = answer();
  result.figures.push({ occurrenceId: "image0", requirementId: "reset", evidenceIds: ["text0"], justification: "Illustrate the requested relay reset information using its linked wiring occurrence." });
  return result;
}
function completion(value: unknown) {
  return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(value) } }] };
}
// All transport is stubbed: no sockets, remote requests, private data or pilot fixtures.
async function mock(run: (requests: Record<string, unknown>[], set: (value: unknown) => void) => Promise<void>) {
  const original = globalThis.fetch;
  const requests: Record<string, unknown>[] = [];
  let response: unknown = completion(answer());
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } });
  };
  try { await run(requests, value => { response = value; }); }
  finally { globalThis.fetch = original; }
}

// Inspect only the conservative subset emitted by the adapter; no provider or
// inference is involved. Host rejection tests below do not trust this schema.
interface WireSchema {
  type?: string;
  enum?: string[];
  properties?: Record<string, WireSchema>;
  items?: WireSchema;
  anyOf?: WireSchema[];
  maxItems?: number;
  required?: string[];
  additionalProperties?: boolean;
}
function requestSchema(request: Record<string, unknown>): WireSchema {
  return (request.response_format as { json_schema: { schema: WireSchema } }).json_schema.schema;
}
function assertReferenceSchema(request: Record<string, unknown>, texts: string[], occurrences: string[]) {
  const schema = requestSchema(request);
  const properties = schema.properties!;
  const figures = properties.figures!;
  const paragraph = properties.paragraphs!.items!;
  assert.deepEqual(properties.wireVersion!.enum, ["grounded-answer-v2"]);
  assert.equal(properties.blocks, undefined);
  for (const item of [properties.requirements!.items!, figures.items!, paragraph]) {
    assert.deepEqual(item.properties!.evidenceIds, { type: "array", items: { type: "string", enum: texts } });
  }
  assert.deepEqual(paragraph.properties!.requirementIds, { type: "array", items: { type: "string" } });
  if (occurrences.length) {
    const reference = { type: "string", enum: occurrences };
    assert.deepEqual(figures.items!.properties!.occurrenceId, reference);
    assert.equal(figures.maxItems, undefined);
  } else {
    assert.equal(figures.maxItems, 0);
    // The unreachable selection item stays a valid object schema.
    assert.deepEqual(figures.items!.properties!.occurrenceId, { type: "string" });
  }
  const inspect = (node: WireSchema): void => {
    if (node.type === "object") {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual(node.required, Object.keys(node.properties!));
    }
    assert.equal(node.anyOf, undefined);
    if (node.enum) assert.ok(node.enum.length > 0, "no empty enums");
    if (node.maxItems !== undefined) { assert.equal(node, figures); assert.equal(node.maxItems, 0); }
    if (node.items) inspect(node.items);
    for (const child of Object.values(node.properties ?? {})) inspect(child);
    for (const child of node.anyOf ?? []) inspect(child);
  };
  inspect(schema);
  assert.doesNotMatch(JSON.stringify(schema), /"(?:minLength|maxLength|minItems|const|not|allOf)":/);
}

test("original query separate from title, strict single request and immutable pre-await snapshots", async () => {
  await mock(async (requests) => {
    const bundle = fixture(), hosts = candidates(), config = { ...options };
    const expected = structuredClone({ bundle, question, title, figurePolicy: "selective", hostDerivedFigureCandidates: hosts });
    const pending = generateAnswer(config, bundle, question, title, "selective", hosts);
    bundle.texts[0]!.id = "mutated"; hosts[0]!.linkedTextIds[0] = "mutated"; hosts[0]!.occurrenceId = "mutated-image"; config.model = "mutated";
    const result = await pending;
    assert.equal(result.status, "answered");
    assert.equal(result.assessment.provenance, "model-judgment");
    assert.equal(result.assessment.semanticProof, false);
    assert.equal(result.document?.title, title);
    assert.ok(Object.isFrozen(result.assessment.requirements[0]));
    assert.equal(requests.length, 1);
    const body = requests[0]! as { model: string; messages: { content: string }[]; response_format: { json_schema: { strict: boolean; schema: { additionalProperties: boolean } } } };
    assert.deepEqual(JSON.parse(body.messages[1]!.content), expected);
    assert.equal(body.model, options.model);
    assertReferenceSchema(requests[0]!, ["text0", "text1", "text2"], ["image0", "image1"]);
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
    const wireSchema = JSON.stringify(body.response_format.json_schema.schema);
    assert.doesNotMatch(wireSchema, /"(?:minLength|maxLength|minItems|maxItems|const)":/);
    assert.match(body.messages[0]!.content, /never claim to have seen pixels/);
  });
});

test("request schema separates text, candidate occurrence and local requirement namespaces", async () => {
  await mock(async (requests) => {
    // All images remain disclosed, but only a trusted candidate is selectable.
    await generateAnswer(options, fixture(), question, title, "selective", candidates().slice(0, 1));
    assertReferenceSchema(requests[0]!, ["text0", "text1", "text2"], ["image0"]);
    const bundle = fixture();
    bundle.texts[2]!.id = "new-request-text";
    await generateAnswer(options, bundle, question, title, "selective", candidates().slice(1));
    assertReferenceSchema(requests[1]!, ["text0", "text1", "new-request-text"], ["image1"]);
    assertReferenceSchema(requests[0]!, ["text0", "text1", "text2"], ["image0"]);
    const prompt = (requests[0]!.messages as { content: string }[])[0]!.content;
    assert.match(prompt, /every evidenceIds array .* uses only bundle.texts\[\].id/);
    assert.match(prompt, /Figure occurrenceId uses only hostDerivedFigureCandidates\[\].occurrenceId/);
    assert.match(prompt, /including illustration-related requirements/);
    assert.match(prompt, /rather than inventing a paragraph/);
  });
});

test("none policy and zero figure candidates forbid selections while permitting paragraphs or insufficiency", async () => {
  await mock(async (requests, set) => {
    for (const policy of ["none", "selective", "required"] as const) {
      for (const hosts of policy === "none" ? [candidates(), []] : [[]]) {
        const raw = answer();
        if (policy === "required") { raw.status = "insufficient-evidence"; raw.paragraphs = []; }
        set(completion(raw));
        const result = await generateAnswer(options, fixture(), question, title, policy, hosts);
        assert.equal(result.status, raw.status);
        assertReferenceSchema(requests.at(-1)!, ["text0", "text1", "text2"], []);
        set(completion(illustrated()));
        await assert.rejects(generateAnswer(options, fixture(), question, title, policy, hosts), /Invalid figure selection/);
      }
    }
    assert.equal(requests.length, 8, "one request per invocation; no repair or retry");
  });
});

test("host rejects namespace violations even when transport ignores the request schema", async () => {
  await mock(async (requests, set) => {
    const mutations: ((raw: AnswerWireResponse) => void)[] = [
      raw => { raw.requirements[0]!.evidenceIds = ["text0", "image0"]; },
      raw => { raw.paragraphs[0]!.evidenceIds = ["text0", "image0"]; },
      raw => { raw.figures[0]!.evidenceIds = ["image0"]; },
      raw => { raw.figures[0]!.occurrenceId = "text0"; },
      raw => { raw.figures[0]!.occurrenceId = "image1"; }, // Disclosed but not a candidate.
    ];
    for (const mutate of mutations) {
      const raw = illustrated(); mutate(raw); set(completion(raw));
      await assert.rejects(generateAnswer(options, fixture(), question, title, "selective", candidates().slice(0, 1)));
    }
    assert.equal(requests.length, mutations.length);
  });
});

test("unsupported multipart, conflict and unassessed cannot be answered; proper abstentions have no document", async () => {
  await mock(async (_requests, set) => {
    for (const status of ["missing", "conflicting", "unassessed"] as const) {
      const raw = answer(), bundle = fixture();
      const requirement = raw.requirements[status === "conflicting" ? 0 : 1]!;
      requirement.status = status;
      requirement.evidenceIds = status === "conflicting" ? ["text0", "text2"] : [];
      if (status === "missing") bundle.texts = bundle.texts.filter(item => item.id !== "text1");
      set(completion(raw));
      await assert.rejects(generateAnswer(options, bundle, question, title, "selective", []), /insufficient/);
      raw.status = "insufficient-evidence";
      set(completion(raw));
      await assert.rejects(generateAnswer(options, bundle, question, title, "selective", []), /Abstention/);
      raw.paragraphs = []; set(completion(raw));
      const result = await generateAnswer(options, bundle, question, title, "selective", []);
      assert.equal(result.status, "insufficient-evidence"); assert.equal(result.document, null);
      assert.ok(result.reasons.includes(status === "missing" ? "missing-support" : status === "conflicting" ? "conflicting-evidence" : "unassessed"));
    }
  });
});

test("foreign IDs, false mappings, malformed/extra fields and incomplete coverage are errors", async () => {
  await mock(async (_requests, set) => {
    const mutations: ((value: AnswerWireResponse) => void)[] = [
      value => { value.requirements[0]!.evidenceIds = ["foreign"]; },
      value => { value.requirements[0]!.evidenceIds = ["image0"]; },
      value => { value.requirements[0]!.evidenceIds = []; },
      value => { value.requirements.push(value.requirements[0]!); },
      value => { value.paragraphs.pop(); },
      value => { value.paragraphs[0]!.requirementIds = ["draw"]; },
      value => { value.paragraphs[0]!.evidenceIds = ["text2"]; },
      value => { Object.assign(value, { privatePath: "/secret" }); },
      value => { value.status = "insufficient-evidence"; value.paragraphs = []; },
      value => { value.requirements = []; },
      value => { value.requirements[0]!.evidenceIds.push("text2"); },
      value => { value.paragraphs[0]!.evidenceIds.push("text0"); },
      value => { value.paragraphs = Array.from({ length: 201 }, () => value.paragraphs[0]!); },
    ];
    for (const mutate of mutations) {
      const raw = answer(); mutate(raw); set(completion(raw));
      await assert.rejects(generateAnswer(options, fixture(), question, title, "selective", candidates()));
    }
  });
});

test("figure policies bind occurrence, supported requirement and exact host linkage; captions host-owned", async () => {
  await mock(async (_requests, set) => {
    set(completion(illustrated()));
    const result = await generateAnswer(options, fixture(), question, title, "required", candidates());
    assert.equal(result.status, "answered");
    assert.deepEqual(result.document?.blocks[2], { kind: "figure", occurrenceId: "image0", caption: "Wiring overview", evidenceIds: ["text0"] });
    await assert.rejects(generateAnswer(options, fixture(), question, title, "none", candidates()), /figure selection/);
    set(completion(answer()));
    assert.equal((await generateAnswer(options, fixture(), question, title, "none", candidates())).status, "answered");
    await assert.rejects(generateAnswer(options, fixture(), question, title, "required", candidates()), /insufficient/);
    const abstain = answer(); abstain.status = "insufficient-evidence"; abstain.paragraphs = []; set(completion(abstain));
    const insufficient = await generateAnswer(options, fixture(), question, title, "required", candidates());
    assert.deepEqual(insufficient.reasons, ["required-figure-missing"]);
    for (const mutate of [
      (raw: AnswerWireResponse) => { raw.figures[0]!.occurrenceId = "image1"; },
      (raw: AnswerWireResponse) => { raw.figures[0]!.evidenceIds = ["text1"]; },
      (raw: AnswerWireResponse) => { raw.figures[0]!.requirementId = "draw"; },
      (raw: AnswerWireResponse) => { raw.figures[0]!.occurrenceId = "foreign"; },
      (raw: AnswerWireResponse) => { raw.paragraphs.pop(); },
      (raw: AnswerWireResponse) => { Object.assign(raw.figures[0]!, { caption: "I see red pixels" }); },
    ]) {
      const raw = illustrated(); mutate(raw); set(completion(raw));
      await assert.rejects(generateAnswer(options, fixture(), question, title, "selective", candidates()));
    }
  });
});

test("illustrations cannot substitute for paragraph answer coverage", async () => {
  await mock(async (_requests, set) => {
    const raw = illustrated();
    raw.requirements = [raw.requirements[0]!];
    raw.paragraphs = [];
    set(completion(raw));
    for (const caption of ["Wiring overview", ""]) {
      const hosts = candidates(); hosts[0]!.caption = caption;
      await assert.rejects(generateAnswer(options, fixture(), "What is the reset interval?", title, "required", hosts), /Incomplete answer mappings/);
    }
  });
});

test("OCR render provenance survives none policy unchanged in approved request", async () => {
  await mock(async (requests) => {
    const bundle = fixture();
    const provenance = { kind: "ocr" as const, verification: "unverified" as const, sourceHash: hash("manual"), page: 1, pageCount: 3, pageRenderHash: hash("render"), transcriptHash: hash(bundle.texts[0]!.text), stackFingerprint: hash("stack"), recipeFingerprint: hash(OCR_RECIPE), width: 100, height: 100 };
    bundle.texts[0]!.provenance = { ...provenance, transcriptStart: 0, transcriptEnd: bundle.texts[0]!.text.length };
    bundle.images.push({ id: "ocrRender", sourceId: "source", locator: { kind: "page", page: 1 }, originKind: "page_render", blobHash: provenance.pageRenderHash, provenance });
    const before = structuredClone(bundle);
    const result = await generateAnswer(options, bundle, question, title, "none", candidates());
    assert.ok(result.document?.blocks.every(block => block.kind === "paragraph"));
    assert.deepEqual(bundle, before);
    const messages = requests[0]!.messages as { content: string }[];
    assert.deepEqual(JSON.parse(messages[1]!.content).bundle, before);
    bundle.images.pop();
    await assert.rejects(generateAnswer(options, bundle, question, title, "none", candidates()), /OCR/);
  });
});

test("approval and strict disclosure budgets checked even for deterministic empty candidates", async () => {
  await mock(async (requests) => {
    const empty = fixture(); empty.texts = []; empty.images = [];
    await assert.rejects(generateAnswer({ ...options, approved: false }, empty, question, title, "none", []), /approved/);
    const result = await generateAnswer(options, empty, question, title, "required", []);
    assert.equal(result.document, null); assert.deepEqual(result.reasons, ["no-candidates"]);
    assert.equal(result.assessment.provenance, "deterministic");
    for (const timeoutMs of [0, NaN, 180001, 1.5]) await assert.rejects(generateAnswer({ ...options, timeoutMs }, empty, question, title, "none", []), /timeoutMs/);
    await assert.rejects(generateAnswer({ ...options, endpoint: "http://foreign.invalid" }, empty, question, title, "none", []), /endpoint/);
    await assert.rejects(generateAnswer(options, fixture(), "x".repeat(8193), title, "none", []), /oversized/);
    await assert.rejects(generateAnswer(options, { ...fixture(), privatePath: "secret" } as EvidenceBundle, question, title, "none", []), /fields/);
    const bad = candidates(); bad[0]!.linkedTextIds = ["foreign"];
    await assert.rejects(generateAnswer(options, fixture(), question, title, "none", bad), /reference/);
    const foreign = fixture(); foreign.sources.push({ id: "otherSource", label: "Other manual", revisionHash: hash("other") }); foreign.texts[0]!.sourceId = "otherSource";
    await assert.rejects(generateAnswer(options, foreign, question, title, "none", candidates()), /reference/);
    const extraCaption = candidates(); Object.assign(extraCaption[0]!, { privatePath: "secret" });
    await assert.rejects(generateAnswer(options, fixture(), question, title, "none", extraCaption), /fields/);
    const big = fixture(); big.sources[0]!.label = "文".repeat(100000); big.texts[0]!.text = "文".repeat(100000); big.texts[0]!.end = 100000; big.texts[0]!.textHash = hash(big.texts[0]!.text);
    await assert.rejects(generateAnswer(options, big, question, title, "none", []), /budget/);
    assert.equal(requests.length, 0);
  });
});

test("invalid JSON, refusal, truncation and oversized content are errors not abstentions", async () => {
  await mock(async (requests, set) => {
    for (const response of [
      { choices: [] },
      { choices: [{ finish_reason: "length", message: { role: "assistant", content: "{}" } }] },
      { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "{}", refusal: "refused" } }] },
      { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "not JSON" } }] },
      { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "x".repeat(65537) } }] },
    ]) {
      set(response); await assert.rejects(generateAnswer(options, fixture(), question, title, "none", []));
    }
    assert.equal(requests.length, 5);
  });
});

test("transport HTTP and deadline failures propagate without retries or abstention", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return new Response("failure", { status: 503 }); };
    await assert.rejects(generateAnswer(options, fixture(), question, title, "none", []), /HTTP 503/);
    globalThis.fetch = async (_url, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("deadline not enforced")), 1000);
        init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
      });
    };
    await assert.rejects(generateAnswer({ ...options, timeoutMs: 10 }, fixture(), question, title, "none", []), /timed out after 10 ms/);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test("wire v2 rejects legacy mixed responses, wrong versions and extra fields at every level", async () => {
  await mock(async (requests, set) => {
    const old = { status: "answered", requirements: answer().requirements, figures: illustrated().figures,
      blocks: [{ kind: "figure", occurrenceId: "image0" }] };
    const mutations = [
      () => old,
      () => ({ ...old, blocks: answer().paragraphs.map(p => ({ kind: "paragraph", ...p })) }),
      () => ({ ...answer(), wireVersion: "grounded-answer-v1" }),
      () => { const { wireVersion: _, ...raw } = answer(); return raw; },
      () => ({ ...answer(), blocks: [] }),
      () => { const raw = answer(); Object.assign(raw.paragraphs[0]!, { kind: "paragraph" }); return raw; },
      () => { const raw = answer(); Object.assign(raw.requirements[0]!, { caption: "invented" }); return raw; },
      () => { const raw = illustrated(); Object.assign(raw.figures[0]!, { caption: "invented" }); return raw; },
      () => ({ ...illustrated(), paragraphs: [{ kind: "figure", occurrenceId: "image0" }] }),
      () => { const { paragraphs: _, ...raw } = illustrated(); return raw; },
    ];
    for (const mutation of mutations) {
      set(completion(mutation()));
      await assert.rejects(generateAnswer(options, fixture(), question, title, "selective", candidates()));
    }
    assert.equal(requests.length, mutations.length, "no legacy fallback or response repair");
  });
});

test("paragraphs must pass coverage before host assembly under every figure policy", async () => {
  await mock(async (_requests, set) => {
    for (const policy of ["none", "selective", "required"] as const) {
      const raw = policy === "none" ? answer() : illustrated();
      raw.paragraphs = [];
      set(completion(raw));
      await assert.rejects(generateAnswer(options, fixture(), question, title, policy, candidates()), /Incomplete answer mappings/);
      raw.paragraphs = [answer().paragraphs[0]!];
      set(completion(raw));
      await assert.rejects(generateAnswer(options, fixture(), question, title, policy, candidates()), /Incomplete answer mappings/);
      raw.paragraphs = answer().paragraphs;
      raw.paragraphs[0]!.text = " ";
      set(completion(raw));
      await assert.rejects(generateAnswer(options, fixture(), question, title, policy, candidates()), /Invalid or oversized answer text/);
    }
  });
});

test("host keeps paragraph order then selection order and exact original captions, with combined block budget", async () => {
  await mock(async (_requests, set) => {
    const raw = illustrated();
    raw.figures.unshift({ occurrenceId: "image1", requirementId: "draw", evidenceIds: ["text1"], justification: "Illustrate standby draw" });
    const hosts = candidates(); hosts[1]!.caption = "";
    set(completion(raw));
    const result = await generateAnswer(options, fixture(), question, title, "selective", hosts);
    assert.deepEqual(result.document?.blocks, [
      ...raw.paragraphs.map(({ requirementIds: _, ...paragraph }) => ({ kind: "paragraph", ...paragraph })),
      { kind: "figure", occurrenceId: "image1", caption: "", evidenceIds: ["text1"] },
      { kind: "figure", occurrenceId: "image0", caption: "Wiring overview", evidenceIds: ["text0"] },
    ]);
    const repeated = illustrated(); repeated.figures.push(repeated.figures[0]!);
    set(completion(repeated));
    await assert.rejects(generateAnswer(options, fixture(), question, title, "required", hosts), /Invalid figure selection/);
    raw.paragraphs = Array.from({ length: 198 }, (_, i) => answer().paragraphs[i % 2]!);
    set(completion(raw));
    assert.equal((await generateAnswer(options, fixture(), question, title, "required", hosts)).document?.blocks.length, 200);
    raw.paragraphs.push(answer().paragraphs[0]!);
    set(completion(raw));
    await assert.rejects(generateAnswer(options, fixture(), question, title, "required", hosts), /budget/);
  });
});

test("optional llama.cpp controls preserve default request and snapshot nested caller state", async () => {
  await mock(async (requests, set) => {
    await generateAnswer(options, fixture(), question, title, "none", []);
    const baseline = requests[0]!;
    assert.deepEqual(Object.keys(baseline).sort(), ["messages", "model", "response_format"]);
    const generation = { protocol: "llama.cpp" as const, maxTokens: 2048, enableThinking: false, reasoningBudgetTokens: 0 };
    const pending = generateAnswer({ ...options, generation }, fixture(), question, title, "none", []);
    generation.maxTokens = 1; generation.enableThinking = true; generation.reasoningBudgetTokens = 100;
    await pending;
    assert.deepEqual(requests[1], { ...baseline, max_tokens: 2048, chat_template_kwargs: { enable_thinking: false }, reasoning_budget_tokens: 0 });
    await generateAnswer({ ...options, generation: { protocol: "llama.cpp" } }, fixture(), question, title, "none", []);
    assert.deepEqual(requests[2], baseline);
    await generateAnswer({ ...options, generation: { protocol: "llama.cpp", enableThinking: true, maxTokens: 32768, reasoningBudgetTokens: 32768 } }, fixture(), question, title, "none", []);
    assert.deepEqual(requests[3], { ...baseline, max_tokens: 32768, chat_template_kwargs: { enable_thinking: true }, reasoning_budget_tokens: 32768 });
    set({ choices: [{ finish_reason: "length", message: { role: "assistant", content: JSON.stringify(answer()) } }] });
    await assert.rejects(generateAnswer({ ...options, generation }, fixture(), question, title, "none", []), /Incomplete model response/);
    assert.equal(requests.length, 5, "no retry on capped finish");
  });
});

test("malformed library answer profiles and refused approval have zero egress", async () => {
  await mock(async requests => {
    for (const generation of [null, [], "llama.cpp", {}, { maxTokens: 1 }, { protocol: "openai" },
      { protocol: "llama.cpp", enableThinking: "false" }, { protocol: "llama.cpp", extra: true },
      ...[0, -1, 32769, 1.5, NaN, Infinity, "2048"].map(maxTokens => ({ protocol: "llama.cpp", maxTokens })),
      ...[-1, 32769, 1.5, NaN, "0"].map(reasoningBudgetTokens => ({ protocol: "llama.cpp", reasoningBudgetTokens })),
    ]) {
      // Deliberately malformed runtime caller, not a tool argument.
      const config = { ...options, generation } as unknown as import("../src/adapters/models/answer-model-options.ts").AnswerModelOptions;
      await assert.rejects(generateAnswer(config, fixture(), question, title, "none", []), /generation/);
    }
    await assert.rejects(generateAnswer({ ...options, approved: false, generation: { protocol: "llama.cpp", maxTokens: 2048 } }, fixture(), question, title, "none", []), /approved/);
    assert.equal(requests.length, 0);
  });
});

test("profile snapshots and nested payload are immutable; vision fingerprints ignore answer controls", async () => {
  const { answerGenerationFromEnv, answerGenerationPayload } = await import("../src/adapters/models/answer-model-options.ts");
  const { visionFingerprints } = await import("../src/adapters/models/grounded-model.ts");
  const env = { PI_KS_V2_GENERATE_PROTOCOL: "llama.cpp", PI_KS_V2_GENERATE_ENABLE_THINKING: "false" };
  const profile = answerGenerationFromEnv(env)!;
  env.PI_KS_V2_GENERATE_ENABLE_THINKING = "true";
  assert.equal(profile.enableThinking, false);
  assert.ok(Object.isFrozen(profile));
  const payload = answerGenerationPayload(profile);
  assert.ok(Object.isFrozen(payload)); assert.ok(Object.isFrozen(payload.chat_template_kwargs));
  assert.throws(() => Object.assign(profile, { protocol: "other" }), TypeError);
  assert.throws(() => Object.assign(payload.chat_template_kwargs as object, { enable_thinking: true }), TypeError);
  const configured = { ...options, generation: profile };
  assert.deepEqual(visionFingerprints(configured, "Describe", "v1"), visionFingerprints(options, "Describe", "v1"));
});

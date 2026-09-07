import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import test from "node:test";
import { boundedJsonPost, type ModelTelemetryEvent } from "../src/adapters/models/http-embedding.ts";
import { generateAnswer } from "../src/adapters/models/grounded-answer.ts";
import { AnswerCoverageError, validateAnswer } from "../src/application/validate-answer.ts";
import type { EvidenceBundle } from "../src/domain/evidence.ts";

async function local(run: (url: string, events: ModelTelemetryEvent[]) => Promise<void>, reply: (res: ServerResponse) => void) {
  const server = createServer(async (req, res) => { for await (const _ of req) { /* drain */ } reply(res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try { await run(`http://127.0.0.1:${address.port}/?private=SECRET`, []); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const bundle: EvidenceBundle = {
  schemaVersion: 1, id: "b", snapshotId: "s", sources: [{ id: "s", label: "Synthetic", revisionHash: hash("source") }],
  texts: ["Synthetic latch closes.", "Synthetic latch opens."].map((text, i) => ({ id: `t${i}`, sourceId: "s", elementId: `e${i}`, locator: { kind: "page", page: 1 }, text, textHash: hash(text), start: 0, end: text.length })), images: [],
};
const wire = () => ({ wireVersion: "grounded-answer-v2", status: "answered", requirements: [{ id: "r", requirement: "Latch", status: "supported", evidenceIds: ["t0", "t1"] }], figures: [], paragraphs: [{ text: "SECRET", evidenceIds: ["t0", "t1"], requirementIds: ["r"] }] });
const envelope = (content: string, finish_reason = "stop") => ({ choices: [{ finish_reason, message: { role: "assistant", content, reasoning_content: "SECRET" } }], usage: { prompt_tokens: 12, completion_tokens: -1, total_tokens: "99", completion_tokens_details: { reasoning_tokens: 4, secret: "SECRET" }, prompt_tokens_details: { cached_tokens: 0 }, unknown: 42 }, timings: { secret: "SECRET" } });

test("delayed headers/body measure offsets and bytes without content", async () => {
  await local(async (url, events) => {
    assert.deepEqual(await boundedJsonPost(url, { prompt: "SECRET" }, "SECRET", { observer: e => { events.push(e); } }), { ok: true });
    const e = events[0]!;
    assert.equal(events.length, 1); assert.equal(e.outcome, "success"); assert.equal(e.status, 200);
    // These are client-observed offsets, not server timer durations. Under load,
    // headers and buffered body chunks can become observable in the same turn.
    assert.ok(Number.isFinite(e.headersMs) && e.headersMs! >= 0);
    assert.ok(Number.isFinite(e.firstBodyByteMs) && e.firstBodyByteMs! >= e.headersMs!);
    assert.ok(e.bodyCompleteMs! >= e.firstBodyByteMs!); assert.ok(e.envelopeParsedMs! >= e.bodyCompleteMs!);
    assert.equal(e.requestBytes, Buffer.byteLength(JSON.stringify({ prompt: "SECRET" })));
    assert.equal(e.responseBytes, Buffer.byteLength('{"ok":true}'));
    assert.doesNotMatch(JSON.stringify(events), /SECRET|private|http:|prompt"/);
    assert.equal(Object.hasOwn(e, "usage"), false);
  }, res => { setTimeout(() => { res.writeHead(200); res.flushHeaders(); setTimeout(() => { res.write('{"ok":'); setTimeout(() => res.end('true}'), 30); }, 40); }, 40); });
});

test("timeouts distinguish pre-header and partial-body; malformed JSON and HTTP fail unchanged", async () => {
  for (const mode of ["headers", "body", "json", "http"] as const) {
    await local(async (url, events) => {
      await assert.rejects(boundedJsonPost(url, {}, undefined, { timeoutMs: 150, observer: e => { events.push(e); } }), mode === "json" ? /Invalid model response JSON/ : mode === "http" ? /Model HTTP 503/ : /timed out after 150 ms/);
      const e = events[0]!;
      assert.equal(events.length, 1);
      assert.equal(e.phase, { headers: "fetch", body: "body", json: "envelope-json", http: "headers" }[mode]);
      assert.equal(e.outcome, mode === "headers" || mode === "body" ? "timeout" : "error");
      if (mode === "headers") { assert.equal(Object.hasOwn(e, "status"), false); assert.equal(Object.hasOwn(e, "responseBytes"), false); }
      if (mode === "body") { assert.equal(e.responseBytes, 1); assert.ok(e.firstBodyByteMs !== undefined); assert.equal(Object.hasOwn(e, "bodyCompleteMs"), false); }
    }, res => { if (mode === "body") res.write("{"); if (mode === "json") res.end("SECRET"); if (mode === "http") res.writeHead(503).end("SECRET"); });
  }
});

test("generation reports finish length, sanitized usage, JSON and coverage failure phases", async () => {
  for (const mode of ["ok", "length", "unknown", "json", "coverage"] as const) {
    const answer = wire(); if (mode === "coverage") answer.paragraphs[0]!.evidenceIds = ["t0"];
    await local(async (url, events) => {
      const pending = generateAnswer({ endpoint: url, model: "SECRET", apiKey: "SECRET", approved: true }, bundle, "SECRET", "Title", "none", [], e => { events.push(e); });
      if (mode === "ok") assert.equal((await pending).status, "answered");
      else await assert.rejects(pending, mode === "length" || mode === "unknown" ? /Incomplete model response/ : mode === "coverage" ? /Incomplete answer mappings/ : SyntaxError);
      assert.equal(events.length, 2);
      const e = events[1]!;
      assert.equal(e.phase, mode === "ok" ? "complete" : mode === "json" ? "answer-json" : mode === "coverage" ? "validation" : "completion");
      assert.equal(e.finishReason, mode === "length" ? "length" : mode === "unknown" ? "other" : "stop");
      assert.deepEqual(e.usage, { prompt_tokens: 12, reasoning_tokens: 4, cached_tokens: 0 });
      if (mode === "coverage") assert.deepEqual(e.coverage, { emptyBlocks: 0, uncoveredRequirements: 0, undisplayedFigures: 0, missingEvidenceMappings: 1 });
      assert.doesNotMatch(JSON.stringify(events), /SECRET|private|reasoning_content|timings|unknown/);
    }, res => res.end(JSON.stringify(envelope(mode === "json" ? "SECRET" : JSON.stringify(answer), mode === "length" ? "length" : mode === "unknown" ? "SECRET" : "stop"))));
  }
});

test("coverage errors retain substring and expose bounded branch counts", () => {
  const answer = wire(); answer.paragraphs = [];
  assert.throws(() => validateAnswer(answer, bundle, "Question", "Title", "none", []), error => {
    assert.ok(error instanceof AnswerCoverageError); assert.equal(error.category, "incomplete-answer-mappings");
    assert.equal(error.message, "Incomplete answer mappings");
    assert.deepEqual(error.counts, { emptyBlocks: 1, uncoveredRequirements: 1, undisplayedFigures: 0, missingEvidenceMappings: 2 }); return true;
  });
});

test("throwing/rejecting observers preserve success, errors and pre-egress approval", async () => {
  for (const observer of [() => { throw new Error("observer"); }, async () => { throw new Error("observer"); }]) {
    await local(async url => {
      const config = { endpoint: url, model: "fixture", approved: true };
      assert.deepEqual(await generateAnswer(config, bundle, "Q", "T", "none", [], observer), await generateAnswer(config, bundle, "Q", "T", "none", []));
      await assert.rejects(generateAnswer({ ...config, approved: false }, bundle, "Q", "T", "none", [], observer), /not approved/);
      await assert.rejects(boundedJsonPost(url, {}, undefined, { timeoutMs: 0, observer }), /Invalid model timeoutMs/);
    }, res => res.end(JSON.stringify(envelope(JSON.stringify(wire())))));
  }
});

test("host displays each selection after validated paragraphs without a second display mapping", () => {
  const evidence = structuredClone(bundle);
  evidence.images.push({ id: "image", sourceId: "s", locator: { kind: "page", page: 1 }, blobHash: hash("image"), originKind: "embedded_original" });
  const answer = { ...wire(), figures: [{ occurrenceId: "image", requirementId: "r", evidenceIds: ["t0"], justification: "Illustrate latch" }] };
  const result = validateAnswer(answer, evidence, "Q", "T", "required", [{ occurrenceId: "image", linkedTextIds: ["t0"], caption: "Latch" }]);
  assert.deepEqual(result.document?.blocks.map(block => block.kind), ["paragraph", "figure"]);
  assert.deepEqual(result.document?.blocks[1], { kind: "figure", occurrenceId: "image", evidenceIds: ["t0"], caption: "Latch" });
});

test("observation preserves request/response byte limits and redirect rejection", async () => {
  await local(async (url, events) => {
    await assert.rejects(boundedJsonPost(url, "x".repeat(4 * 1024 * 1024), undefined, { observer: e => { events.push(e); } }), /request exceeds budget/);
    assert.equal(events[0]!.phase, "prepare");
    assert.equal(Object.hasOwn(events[0]!, "fetchMs"), false);
    await assert.rejects(boundedJsonPost(url, {}, undefined, { observer: e => { events.push(e); } }), /response exceeds budget/);
    assert.equal(events[1]!.phase, "body"); assert.ok(events[1]!.responseBytes! > 8 * 1024 * 1024);
  }, res => res.end("x".repeat(8 * 1024 * 1024 + 1)));
  let requests = 0;
  await local(async (url, events) => {
    await assert.rejects(boundedJsonPost(url, {}, undefined, { observer: e => { events.push(e); } }));
    assert.equal(requests, 1); assert.equal(events[0]!.outcome, "error");
  }, res => { requests++; res.writeHead(302, { location: "/again" }).end(); });
});

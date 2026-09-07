#!/usr/bin/env node
// Opt-in synthetic development experiment, NOT a production adapter or frozen evaluation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateAnswer } from '../src/adapters/models/grounded-answer.ts';
import { ANSWER_WIRE_VERSION } from '../src/domain/answer.ts';
import { boundedJsonPost } from '../src/adapters/models/http-embedding.ts';
import { exportPortableDocument } from '../src/adapters/export/portable-export.ts';
import { encodePng } from '../src/adapters/export/encode-png.ts';

if (process.argv.length !== 3 || process.argv[2] !== '--run-authorized-synthetic') {
  console.error('Requires --run-authorized-synthetic; sends at most two sequential inference requests.');
  process.exit(2);
}
const root = '/tmp/studio-generation-reference';
await mkdir(root, { recursive: true, mode: 0o700 });
const dir = await mkdtemp(join(root, `run-${ANSWER_WIRE_VERSION}-`));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (name, data) => writeFile(join(dir, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const endpoint = 'http://127.0.0.1:18082/v1/chat/completions';
const model = 'qwen3.8-27b-q5';
const report = { started: new Date().toISOString(), wireVersion: ANSWER_WIRE_VERSION, experiment: 'synthetic-development-regression-not-heldout', calls: [], checks: [] };
const sourcePaths = ['src/domain/answer.ts', 'src/adapters/models/grounded-answer.ts', 'src/application/validate-answer.ts', 'src/adapters/models/http-embedding.ts', 'src/adapters/export/portable-export.ts', 'scripts/generation-reference-smoke.mjs'];
const fingerprints = {};
for (const path of sourcePaths) {
  const bytes = await readFile(new URL('../' + path, import.meta.url));
  fingerprints[path] = hash(bytes);
  await writeFile(join(dir, path.replaceAll('/', '__')), bytes, { flag: 'wx', mode: 0o600 });
}
await save('source-fingerprints.json', fingerprints);
report.sourceFingerprints = fingerprints;
let count = 0, timedOut = false;
async function inspect(label) {
  const get = async path => {
    const r = await fetch(`http://127.0.0.1:18082/${path}`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!r.ok) throw new Error(`Read-only ${path} HTTP ${r.status}`);
    return r.json();
  };
  const health = await get('health');
  const slots = await get('slots');
  const idle = health.status === 'ok' && Array.isArray(slots) && slots.length > 0 && slots.every(s => s.is_processing === false);
  report.checks.push({ label, at: new Date().toISOString(), health: health.status === 'ok', idle,
    slots: Array.isArray(slots) ? slots.map(s => ({ id: s.id, is_processing: s.is_processing })) : [] });
  return idle;
}
async function post(body, call) {
  assert.ok(++count <= 2, 'Inference limit');
  const started = performance.now();
  try {
    // 1 second below the outer generation deadline; aborts never prove remote cancellation.
    const response = await boundedJsonPost(endpoint, body, undefined, { timeoutMs: 179000, observer: e => {
      call.upstreamTelemetry.push(e); if (e.outcome === 'timeout') timedOut = true;
    } });
    await save(`${call.label}-synthetic-response.json`, response);
    return response;
  } finally { call.upstreamDurationMs = performance.now() - started; }
}
// Predetermined authored Saffron regression fixture, unchanged from the prior run.
// Not a frozen/held-out fixture or real manual.
const text = 'Synthetic development source: the Saffron beacon timer uses a 43-second settling interval. Its indicator budget is 9 milliwatts. The accompanying original swatch is a decorative identifier, not a measurement plot.';
// Authored pixels establish this synthetic source's initial PNG bytes, not a rendition
// or extraction from any prior document. No pixels are sent to the language model.
const png = encodePng(2, 2, 3, Uint8Array.from([31, 92, 142, 231, 172, 62, 231, 172, 62, 31, 92, 142]));
const imageHash = hash(png);
const bundle = { schemaVersion: 1, id: 'saffron-dev-bundle', snapshotId: 'saffron-dev-snapshot',
  sources: [{ id: 'saffron-source', label: 'Authored synthetic Saffron note and original swatch', revisionHash: hash(text) }],
  texts: [{ id: 'saffron-text', sourceId: 'saffron-source', elementId: 'saffron-note', locator: { kind: 'lines', start: 1, end: 1 }, text, textHash: hash(text), start: 0, end: text.length }],
  images: [{ id: 'saffron-swatch', sourceId: 'saffron-source', locator: { kind: 'anchor', anchor: 'original-swatch' }, blobHash: imageHash, originKind: 'standalone_original' }] };
const question = 'For the synthetic Saffron beacon timer, state its settling interval and indicator power budget. Include the accompanying original decorative identifier swatch, without inferring measurements from its pixels.';
const title = 'Synthetic Saffron timer note';
const candidates = [{ occurrenceId: 'saffron-swatch', linkedTextIds: ['saffron-text'], caption: 'Original decorative identifier swatch for the synthetic Saffron note; not a measurement plot.' }];
await writeFile(join(dir, 'original.png'), png, { flag: 'wx', mode: 0o600 });
await save('fixture.json', { bundle, question, title, figurePolicies: ['required', 'none'], candidates });
const blobs = { async get(id) { assert.equal(id, imageHash); const bytes = await readFile(join(dir, 'original.png')); assert.equal(hash(bytes), id); return bytes; } };
try {
  if (!await inspect('initial')) throw new Error('DEFER: unhealthy or busy slots');
  const modelsResponse = await fetch('http://127.0.0.1:18082/v1/models', { signal: AbortSignal.timeout(5000), redirect: 'error' });
  assert.ok(modelsResponse.ok);
  assert.ok((await modelsResponse.json()).data.some(item => item.id === model), 'Registered model mismatch');
  let baseline;
  for (const policy of ['required', 'none']) {
    if (!await inspect(`before-${policy}`)) throw new Error('DEFER: unhealthy or busy slots');
    const call = { label: `answer-${policy}`, policy, controls: { max_tokens: 2048, chat_template_kwargs: { enable_thinking: false }, reasoning_budget_tokens: 0 }, upstreamTelemetry: [], telemetry: [] };
    report.calls.push(call);
    let used = false;
    // Temporary, single-use loopback forwarder: ONLY three experimental fields
    // are added. Prompts/schema/model are unchanged; no production capability claim.
    const server = createServer(async (req, res) => {
      try {
        assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/chat/completions'); assert.equal(used, false); used = true;
        assert.equal(req.headers.authorization, undefined);
        const chunks = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; assert.ok(bytes <= 4 * 1024 * 1024); chunks.push(chunk); }
        const body = JSON.parse(Buffer.concat(chunks).toString());
        assert.deepEqual(Object.keys(body).sort(), ['messages', 'model', 'response_format']);
        assert.equal(body.response_format.json_schema.strict, true);
        assert.equal(body.model, model);
        const requestBytes = Buffer.concat(chunks);
        await writeFile(join(dir, `${call.label}-production-request.json`), requestBytes, { flag: 'wx', mode: 0o600 });
        await save(`${call.label}-schema.json`, body.response_format);
        call.requestSha256 = hash(requestBytes);
        call.schemaSha256 = hash(JSON.stringify(body.response_format));
        const payload = JSON.parse(body.messages[1].content);
        assert.deepEqual(payload, { bundle, question, title, figurePolicy: policy, hostDerivedFigureCandidates: candidates });
        if (baseline) {
          assert.equal(body.messages[0].content, baseline.messages[0].content);
          const previous = JSON.parse(baseline.messages[1].content);
          assert.deepEqual({ ...payload, figurePolicy: previous.figurePolicy }, previous);
        } else baseline = structuredClone(body);
        const schema = body.response_format.json_schema.schema;
        let evidenceArrays = 0, occurrenceFields = 0;
        function checkSchema(node) {
          if (!node || typeof node !== 'object') return;
          if (node.properties?.evidenceIds) {
            assert.deepEqual(node.properties.evidenceIds.items.enum, ['saffron-text']); evidenceArrays++;
          }
          if (node.properties?.occurrenceId) {
            assert.deepEqual(node.properties.occurrenceId, policy === 'required' ? { type: 'string', enum: ['saffron-swatch'] } : { type: 'string' }); occurrenceFields++;
          }
          for (const value of Object.values(node)) if (typeof value === 'object') checkSchema(value);
        }
        checkSchema(schema);
        assert.equal(evidenceArrays, 3);
        assert.equal(occurrenceFields, 1);
        assert.deepEqual(schema.properties.wireVersion.enum, [ANSWER_WIRE_VERSION]);
        assert.equal(body.response_format.json_schema.name, 'grounded_answer_v2');
        call.wireVersion = ANSWER_WIRE_VERSION;
        assert.equal(schema.properties.blocks, undefined);
        assert.deepEqual(Object.keys(schema.properties.paragraphs.items.properties), ['text', 'evidenceIds', 'requirementIds']);
        if (policy === 'none') {
          assert.equal(schema.properties.figures.maxItems, 0);
        }
        call.schemaChecksPassed = true;
        const forwarded = { ...body, ...call.controls };
        await save(`${call.label}-forwarded-request.json`, forwarded);
        call.forwardedRequestSha256 = hash(JSON.stringify(forwarded));
        const response = await post(forwarded, call);
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response));
      } catch (e) { call.forwarderError = String(e.message); res.writeHead(502); res.end('{}'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const start = performance.now();
    try {
      const result = await generateAnswer({ endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, model, approved: true, timeoutMs: 180000 }, bundle, question, title, policy, candidates, e => call.telemetry.push(e));
      call.generationDurationMs = performance.now() - start;
      call.status = result.status;
      await save(`${call.label}-validated-answer.json`, result);
      call.requirementMappings = result.assessment.requirements.map(r => ({ id: r.id, status: r.status, evidenceIds: r.evidenceIds }));
      call.figureMappings = result.assessment.figures.map(f => ({ occurrenceId: f.occurrenceId, requirementId: f.requirementId, evidenceIds: f.evidenceIds }));
      assert.equal(result.status, 'answered', 'Insufficiency is not successful development answer');
      const paragraphs = result.document.blocks.filter(b => b.kind === 'paragraph');
      const prose = paragraphs.map(b => b.text).join(' ');
      assert.match(prose, /43/); assert.match(prose, /9/);
      assert.ok(paragraphs.length > 0);
      call.strictParagraphCoveragePassed = true; // generateAnswer ran the unchanged strict validator.
      if (policy === 'required') {
        assert.equal(result.assessment.figures.length, 1);
        assert.equal(result.document.blocks.filter(b => b.kind === 'figure').length, 1);
        const out = await exportPortableDocument(dir, bundle, result.document, { documentContent: true, images: true, excerpts: true }, blobs);
        const original = await readFile(join(out, 'assets', `${imageHash}.png`));
        assert.deepEqual(original, png);
        const html = await readFile(join(out, 'document.html'), 'utf8');
        assert.ok(html.includes(`assets/${imageHash}.png`)); assert.ok(html.includes('href="#saffron-text"'));
        const sources = JSON.parse(await readFile(join(out, 'sources.json'), 'utf8'));
        assert.equal(sources.occurrences.length, 1);
        assert.equal(sources.occurrences[0].id, 'saffron-swatch');
        assert.equal(sources.occurrences[0].sourceId, 'saffron-source');
        assert.equal(sources.occurrences[0].blobHash, imageHash);
        assert.equal(sources.occurrences[0].originKind, 'standalone_original');
        const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
        for (const file of manifest.files) assert.equal(hash(await readFile(join(out, file.path))), file.sha256);
        call.export = { path: out, originalByteIdentical: true, originalSha256: imageHash, citationsChecked: true, manifestVerified: true };
      } else {
        assert.equal(result.assessment.figures.length, 0);
        assert.equal(result.document.blocks.filter(b => b.kind === 'figure').length, 0);
        call.zeroIllustrations = true;
      }
      call.outcome = 'success';
    } catch (e) { call.outcome = 'error'; call.error = String(e.message); }
    finally {
      call.totalDurationMs = performance.now() - start;
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); call.forwarderClosed = true;
    }
    const idleAfter = await inspect(`after-${policy}`);
    if (timedOut || call.telemetry.some(e => e.outcome === 'timeout')) throw new Error('STOP: timeout; no further inference');
    if (!idleAfter) throw new Error('STOP: unhealthy or busy after inference');
    // Length is preserved as a failed answer, never parsed/repaired/exported.
  }
} catch (e) { report.stopReason = String(e.message); }
finally {
  try { if (!report.checks.at(-1)?.label.startsWith('after-')) await inspect('final-residual-readonly'); } catch (e) { report.residualCheckError = String(e.message); }
  report.sourcesUnchanged = true;
  for (const path of sourcePaths) {
    if (hash(await readFile(new URL('../' + path, import.meta.url))) !== fingerprints[path]) report.sourcesUnchanged = false;
  }
  report.inferenceCalls = count; report.finished = new Date().toISOString();
  await save('report.json', report);
  // Separate closed, content-free telemetry from synthetic response artifacts/mappings.
  await save('telemetry.json', report.calls.map(c => ({ label: c.label, upstream: c.upstreamTelemetry, pipeline: c.telemetry ?? [] })));
  console.log(JSON.stringify({ directory: dir, report }, null, 2));
}
if (!report.sourcesUnchanged || report.stopReason || report.residualCheckError || report.calls.length !== 2 || report.calls.some(c => c.outcome !== 'success')) process.exitCode = 1;

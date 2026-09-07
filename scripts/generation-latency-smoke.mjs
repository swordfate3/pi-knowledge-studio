#!/usr/bin/env node
// Opt-in synthetic development experiment, NOT a production adapter or frozen evaluation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateAnswer } from '../src/adapters/models/grounded-answer.ts';
import { boundedJsonPost } from '../src/adapters/models/http-embedding.ts';
import { exportPortableDocument } from '../src/adapters/export/portable-export.ts';
import { encodePng } from '../src/adapters/export/encode-png.ts';

if (process.argv.length !== 3 || process.argv[2] !== '--run-authorized-synthetic') {
  console.error('Requires --run-authorized-synthetic; sends at most three sequential inference requests.');
  process.exit(2);
}
const root = '/tmp/studio-generation-latency';
await mkdir(root, { recursive: true, mode: 0o700 });
const dir = await mkdtemp(join(root, 'run-'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (name, data) => writeFile(join(dir, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const endpoint = 'http://127.0.0.1:18082/v1/chat/completions';
const model = 'qwen3.8-27b-q5';
const report = { started: new Date().toISOString(), experiment: 'new-synthetic-development-not-evaluation', calls: [], checks: [] };
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
  assert.ok(++count <= 3, 'Inference limit');
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
// A newly authored synthetic source, not a copied frozen fixture or real manual.
const text = 'Synthetic development source: the Lumen pebble timer uses a 37-second settling interval. Its indicator budget is 6 milliwatts. The accompanying original swatch is a decorative identifier, not a measurement plot.';
// Authored pixels establish this synthetic source's initial PNG bytes, not a rendition
// or extraction from any prior document. No pixels are sent to the language model.
const png = encodePng(2, 2, 3, Uint8Array.from([17, 81, 131, 240, 181, 71, 240, 181, 71, 17, 81, 131]));
const imageHash = hash(png);
const bundle = { schemaVersion: 1, id: 'lumen-dev-bundle', snapshotId: 'lumen-dev-snapshot',
  sources: [{ id: 'lumen-source', label: 'Authored synthetic Lumen note and original swatch', revisionHash: hash(text) }],
  texts: [{ id: 'lumen-text', sourceId: 'lumen-source', elementId: 'lumen-note', locator: { kind: 'lines', start: 1, end: 1 }, text, textHash: hash(text), start: 0, end: text.length }],
  images: [{ id: 'lumen-swatch', sourceId: 'lumen-source', locator: { kind: 'anchor', anchor: 'original-swatch' }, blobHash: imageHash, originKind: 'standalone_original' }] };
const question = 'For the synthetic Lumen pebble timer, state its settling interval and indicator power budget. Include the accompanying original decorative identifier swatch, without inferring measurements from its pixels.';
const title = 'Synthetic Lumen timer note';
const candidates = [{ occurrenceId: 'lumen-swatch', linkedTextIds: ['lumen-text'], caption: 'Original decorative identifier swatch for the synthetic Lumen note; not a measurement plot.' }];
await writeFile(join(dir, 'original.png'), png, { flag: 'wx', mode: 0o600 });
await save('fixture.json', { bundle, question, title, figurePolicy: 'required', candidates });
const blobs = { async get(id) { assert.equal(id, imageHash); const bytes = await readFile(join(dir, 'original.png')); assert.equal(hash(bytes), id); return bytes; } };
try {
  if (!await inspect('initial')) throw new Error('DEFER: unhealthy or busy slots');
  const modelsResponse = await fetch('http://127.0.0.1:18082/v1/models', { signal: AbortSignal.timeout(5000), redirect: 'error' });
  assert.ok(modelsResponse.ok);
  assert.ok((await modelsResponse.json()).data.some(item => item.id === model), 'Registered model mismatch');
  const trivial = { label: 'trivial-disabled', upstreamTelemetry: [] };
  report.calls.push(trivial);
  try {
    const response = await post({ model, messages: [{ role: 'user', content: 'New synthetic development probe. Reply with exactly: LUMEN_DEV_OK' }], stream: false, max_tokens: 128, chat_template_kwargs: { enable_thinking: false }, reasoning_budget_tokens: 0 }, trivial);
    trivial.finishReason = response.choices?.[0]?.finish_reason;
    trivial.exactMatch = response.choices?.[0]?.message?.content?.trim() === 'LUMEN_DEV_OK';
    trivial.usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens'].filter(k => Number.isSafeInteger(response.usage?.[k]) && response.usage[k] >= 0).map(k => [k, response.usage[k]]));
    trivial.outcome = trivial.finishReason === 'stop' && trivial.exactMatch ? 'success' : 'failed';
  } catch (e) { trivial.outcome = 'error'; trivial.error = String(e.message); }
  if (timedOut) throw new Error('STOP: upstream timeout; no further inference');
  if (trivial.outcome !== 'success') throw new Error('STOP: trivial probe failed; no fallback');
  let baseline;
  for (const thinking of [false, true]) {
    if (!await inspect(thinking ? 'before-thinking' : 'before-disabled')) throw new Error('DEFER: unhealthy or busy slots');
    const call = { label: thinking ? 'answer-thinking128' : 'answer-disabled', controls: { max_tokens: 2048, chat_template_kwargs: { enable_thinking: thinking }, reasoning_budget_tokens: thinking ? 128 : 0 }, upstreamTelemetry: [], telemetry: [] };
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
        if (baseline) assert.deepEqual(body, baseline); else { baseline = structuredClone(body); await save('unaltered-pipeline-request.json', body); }
        const response = await post({ ...body, ...call.controls }, call);
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response));
      } catch (e) { call.forwarderError = String(e.message); res.writeHead(502); res.end('{}'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const start = performance.now();
    try {
      const result = await generateAnswer({ endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, model, approved: true, timeoutMs: 180000 }, bundle, question, title, 'required', candidates, e => call.telemetry.push(e));
      call.generationDurationMs = performance.now() - start;
      call.status = result.status;
      await save(`${call.label}-validated-answer.json`, result);
      call.requirementMappings = result.assessment.requirements.map(r => ({ id: r.id, status: r.status, evidenceIds: r.evidenceIds }));
      call.figureMappings = result.assessment.figures.map(f => ({ occurrenceId: f.occurrenceId, requirementId: f.requirementId, evidenceIds: f.evidenceIds }));
      assert.equal(result.status, 'answered', 'Insufficiency is not successful development answer');
      const out = await exportPortableDocument(dir, bundle, result.document, { documentContent: true, images: true, excerpts: true }, blobs);
      const original = await readFile(join(out, 'assets', `${imageHash}.png`));
      assert.deepEqual(original, png);
      const html = await readFile(join(out, 'document.html'), 'utf8');
      assert.ok(html.includes(`assets/${imageHash}.png`)); assert.ok(html.includes('href="#lumen-text"'));
      const sources = JSON.parse(await readFile(join(out, 'sources.json'), 'utf8'));
      assert.equal(sources.occurrences[0].originKind, 'standalone_original');
      const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
      for (const file of manifest.files) assert.equal(hash(await readFile(join(out, file.path))), file.sha256);
      call.export = { path: out, originalByteIdentical: true, originalSha256: imageHash, citationsChecked: true, manifestVerified: true };
      call.outcome = 'success';
    } catch (e) { call.outcome = 'error'; call.error = String(e.message); }
    finally {
      call.totalDurationMs = performance.now() - start;
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); call.forwarderClosed = true;
    }
    if (timedOut || call.telemetry.some(e => e.outcome === 'timeout')) throw new Error('STOP: timeout; no further inference');
    // Length is preserved as a failed answer, never parsed/repaired/exported.
  }
} catch (e) { report.stopReason = String(e.message); }
finally {
  try { await inspect('final-residual-readonly'); } catch (e) { report.residualCheckError = String(e.message); }
  report.inferenceCalls = count; report.finished = new Date().toISOString();
  await save('report.json', report);
  // Separate closed, content-free telemetry from synthetic response artifacts/mappings.
  await save('telemetry.json', report.calls.map(c => ({ label: c.label, upstream: c.upstreamTelemetry, pipeline: c.telemetry ?? [] })));
  console.log(JSON.stringify({ directory: dir, report }, null, 2));
}
if (report.stopReason || report.calls.some(c => c.outcome !== 'success')) process.exitCode = 1;

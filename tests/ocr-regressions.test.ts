import assert from "node:assert/strict";
import { chmod, chown, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import test from "node:test";
import { exportPortableDocument } from "../src/adapters/export/portable-export.ts";
import { sha256 } from "../src/adapters/blob/file-blob-store.ts";
import { captureLocal } from "../src/adapters/parsing/capture-local.ts";
import { effectiveOcrSignal, validateOcrTempRoot } from "../src/adapters/parsing/local-pdf-ocr.ts";
import { KnowledgeRuntime } from "../src/application/knowledge-runtime.ts";
import { validateEvidence } from "../src/application/validate-evidence.ts";
import type { EvidenceBundle, IllustratedDocument } from "../src/domain/evidence.ts";
import { OCR_RECIPE, OCR_WARNING } from "../src/domain/ocr.ts";

function png(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length);
    out.write(type, 4);
    data.copy(out, 8);
    let crc = 0xffffffff;
    for (const byte of out.subarray(4, -4)) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1); header.writeUInt32BE(1, 4);
  header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0]))), chunk("IEND", Buffer.alloc(0))]);
}
function evidence() {
  const bytes = png(), blobHash = sha256(bytes);
  const bundle: EvidenceBundle = {
    schemaVersion: 1, id: "bundle", snapshotId: "snapshot",
    sources: [{ id: "source", label: "Synthetic", revisionHash: sha256("revision") }], texts: [],
    images: [{ id: "figure_1", sourceId: "source", locator: { kind: "page", page: 1 }, originKind: "page_render", blobHash,
      provenance: { kind: "ocr", verification: "unverified", sourceHash: sha256("pdf"), page: 1, pageCount: 2, pageRenderHash: blobHash, transcriptHash: sha256("text"), stackFingerprint: sha256("stack"), recipeFingerprint: sha256(OCR_RECIPE), width: 1, height: 1 } }],
  };
  const document: IllustratedDocument = { title: "Synthetic", bundleId: bundle.id, mode: "model-generated", blocks: [] };
  const refresh = () => { document.blocks = bundle.images.map(i => ({ kind: "figure", occurrenceId: i.id, caption: "Model caption", evidenceIds: [] })); };
  refresh();
  return { bundle, document, refresh, blobs: { get: async () => bytes, put: async (b: Uint8Array) => sha256(b) } };
}
const permission = { documentContent: true, images: true, excerpts: false };
test("figure-only OCR export warns at package and figure without text citations", async t => {
  const root = await mkdtemp(join(tmpdir(), "ocr-export-regression-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = evidence();
  const path = await exportPortableDocument(root, f.bundle, f.document, permission, f.blobs);
  const html = await readFile(join(path, "document.html"), "utf8");
  assert.ok(html.split("<figure>")[0]!.includes(OCR_WARNING));
  assert.ok(/<figcaption>[^]*?<\/figcaption>/.exec(html)![0].includes(OCR_WARNING));
  const md = await readFile(join(path, "document.md"), "utf8");
  assert.equal(md.split("Unverified OCR transcript").length - 1, 2);
  assert.equal(md.split("Page images are derived renders").length - 1, 2);
});
for (const nonOcrFirst of [false, true]) test(`same-blob occurrence geometry checked (non-OCR first: ${nonOcrFirst})`, async t => {
  const root = await mkdtemp(join(tmpdir(), "ocr-geometry-regression-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = evidence();
  const second = structuredClone(f.bundle.images[0]!);
  second.id = "figure_2";
  second.locator = { kind: "page", page: 2 };
  second.provenance!.page = 2;
  second.provenance!.width = 2;
  if (nonOcrFirst) {
    delete f.bundle.images[0]!.provenance;
    f.bundle.images[0]!.originKind = "embedded_original";
  }
  f.bundle.images.push(second); f.refresh();
  validateEvidence(f.bundle, f.document);
  await assert.rejects(exportPortableDocument(root, f.bundle, f.document, permission, f.blobs), /OCR render geometry mismatch/);
  assert.deepEqual(await readdir(root), []);
});

for (const reversed of [false, true]) test(`paragraph-only OCR retains cited duplicate-render page (reversed: ${reversed})`, async t => {
  const root = await mkdtemp(join(tmpdir(), "ocr-page-binding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = evidence();
  const transcript = Buffer.from("Same page text");
  const hash = sha256(transcript);
  f.bundle.images[0]!.provenance!.transcriptHash = hash;
  const second = structuredClone(f.bundle.images[0]!);
  second.id = "figure_2";
  second.locator = { kind: "page", page: 2 };
  second.provenance!.page = 2;
  f.bundle.images.push(second);
  if (reversed) f.bundle.images.reverse();
  f.bundle.texts.push({ id: "text_2", sourceId: "source", elementId: "element_2",
    locator: { kind: "page", page: 2 }, text: transcript.toString(), textHash: hash,
    start: 0, end: transcript.length,
    provenance: { ...second.provenance!, transcriptStart: 0, transcriptEnd: transcript.length } });
  f.document.blocks = [{ kind: "paragraph", text: "Page two evidence", evidenceIds: ["text_2"] }];
  const blobs = { ...f.blobs, get: async (id: string) => id === hash ? transcript : png() };
  const path = await exportPortableDocument(root, f.bundle, f.document, permission, blobs);
  const sources = JSON.parse(await readFile(join(path, "sources.json"), "utf8"));
  assert.deepEqual(sources.occurrences.map((i: { id: string; locator: unknown }) => ({ id: i.id, locator: i.locator })),
    [{ id: "figure_2", locator: { kind: "page", page: 2 } }]);
  assert.equal((await readdir(join(path, "assets"))).length, 1);
});

const configPath = process.env.PI_KS_OCR_TEST_CONFIG;
const fixture = resolve("tests/fixtures/ocr/bilingual-scanned.pdf");
for (const target of ["capture", "runtime"] as const)
for (const phase of ["first", "last"] as const) test(`nested-only abort after recognition during ${phase} flush (${target})`, {
  skip: !configPath && !process.env.PI_KS_OCR_TEST_REQUIRED,
}, async t => {
  assert.ok(configPath);
  const root = await mkdtemp(join(tmpdir(), "ocr-flush-regression-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.tempRoot = join(root, "temp");
  await mkdir(config.tempRoot, { mode: 0o700 });
  const localConfig = join(root, "ocr.json");
  await writeFile(localConfig, JSON.stringify(config), { mode: 0o600 });
  const kb = new KnowledgeRuntime(join(root, "kb"));
  const controller = new AbortController();
  const put = kb.blobs.put.bind(kb.blobs);
  let writes = 0;
  t.mock.method(kb.blobs, "put", async (bytes: Uint8Array) => {
    // External CAS writes start only after recognition, verification and temp cleanup.
    assert.deepEqual(await readdir(config.tempRoot), []);
    const hash = await put(bytes);
    writes++;
    if (phase === "first" || writes === 3) controller.abort();
    return hash;
  });
  const options = { ocr: { approved: true, configPath: localConfig, signal: controller.signal } };
  await assert.rejects(target === "runtime"
    ? kb.ingest(process.cwd(), fixture, options)
    : captureLocal(process.cwd(), fixture, kb.blobs, undefined, options), /aborted/);
  assert.equal(writes, phase === "first" ? 1 : 3);
  assert.deepEqual(await kb.list(), []);
});

test("temp ancestry rejects symlinks/non-sticky shared paths but allows sticky tmp and same-user owners", async t => {
  const root = await mkdtemp(join(tmpdir(), "ocr-ancestor-regression-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shared = join(root, "shared"), leaf = join(shared, "private");
  await mkdir(shared, { mode: 0o700 });
  await mkdir(leaf, { mode: 0o700 });
  await validateOcrTempRoot(leaf);
  for (const mode of [0o777, 0o770]) {
    await chmod(shared, mode);
    await assert.rejects(validateOcrTempRoot(leaf), /unsafe temp root ancestor/);
  }
  await chmod(shared, 0o1777);
  await validateOcrTempRoot(leaf);
  const link = join(root, "link");
  await symlink(shared, link);
  await assert.rejects(validateOcrTempRoot(join(link, "private")), /unsafe temp root ancestor/);
  await assert.rejects(validateOcrTempRoot(join(root, "shared") + "/../shared/private"), /non-canonical/);
  await chmod(leaf, 0o755);
  await assert.rejects(validateOcrTempRoot(leaf), /temp root owner-only/);
});

test("sticky ancestor owned by another user is still untrusted", { skip: process.getuid?.() !== 0 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "ocr-owner-regression-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ancestor = join(root, "other"), leaf = join(ancestor, "private");
  await mkdir(ancestor); await mkdir(leaf, { mode: 0o700 });
  try { await chown(ancestor, 65534, 65534); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    t.skip("chown unavailable in this environment"); return;
  }
  await chmod(ancestor, 0o1777);
  await assert.rejects(validateOcrTempRoot(leaf), /unsafe temp root ancestor/);
});

test("outer and nested cancellation are both observed, including already-aborted nested signal", async () => {
  const outer = new AbortController(), nested = new AbortController();
  const combined = effectiveOcrSignal(outer.signal, nested.signal)!;
  nested.abort();
  assert.throws(() => combined.throwIfAborted(), /aborted/);
  const second = new AbortController();
  const combined2 = effectiveOcrSignal(outer.signal, second.signal)!;
  outer.abort();
  assert.throws(() => combined2.throwIfAborted(), /aborted/);
  let writes = 0;
  await assert.rejects(captureLocal(process.cwd(), fixture, {
    put: async b => { writes++; return sha256(b); }, get: async () => Buffer.alloc(0),
  }, undefined, { signal: second.signal, ocr: { approved: true, configPath: "/missing", signal: nested.signal } }), /aborted/);
  assert.equal(writes, 0);
});

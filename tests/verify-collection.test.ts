import assert from "node:assert/strict";
import test from "node:test";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { FileBlobStore, sha256 } from "../src/adapters/blob/file-blob-store.ts";
import { SqliteCatalog } from "../src/adapters/storage/sqlite-catalog.ts";
import { captureRevision } from "../src/application/validate-capture.ts";
import { verifyCollection, VERIFICATION_LIMITS } from "../src/application/verify-collection.ts";
import { createVisionHint } from "../src/application/vision-hints.ts";
import { encodePng } from "../src/adapters/export/encode-png.ts";
import { prepareImage, storePrepared } from "../src/adapters/parsing/capture-image.ts";
import { OCR_PARSER, OCR_RECIPE } from "../src/domain/ocr.ts";
import type { CapturedDocument } from "../src/domain/retrieval.ts";

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const base = await mkdtemp(join(tmpdir(), "verify-collection-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "collection");
  await mkdir(root, { mode: 0o700 });
  const blobs = new FileBlobStore(join(root, "blobs"));
  const docs: CapturedDocument[] = [];
  for (const text of ["retained inactive", "active"]) {
    const sourceHash = await blobs.put(Buffer.from(text));
    const input = { id: `doc_${sha256("same document")}`, sourceHash, label: "synthetic", parserVersion: "plain-v1", elements: [{ id: "element_0", text, locator: { kind: "lines" as const, start: 1, end: 1 } }], images: [] };
    const doc = { ...input, revision: captureRevision(input) };
    await SqliteCatalog.use(root, async c => c.publish(doc, c.epoch()));
    docs.push(doc);
  }
  return { base, root, blobs, docs };
}
async function snapshot(root: string): Promise<unknown> {
  const result: unknown[] = [];
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name), info = await lstat(path);
    result.push([name, info.mode, info.uid, info.gid, info.mtimeMs, info.isDirectory() ? await snapshot(path) : info.isSymbolicLink() ? "link" : sha256(await readFile(path))]);
  }
  return result;
}
async function audit(root: string) {
  const before = await snapshot(root);
  const report = await verifyCollection(root, { offline: true });
  assert.deepEqual(await snapshot(root), before, "audit must not change bytes, names, modes, owners or mtime");
  return report;
}

test("offline restored active + inactive revisions and informational orphans/staging, byte read-only", async t => {
  const f = await fixture(t);
  await f.blobs.put(Buffer.from("orphan"));
  await writeFile(join(f.root, "blobs", ".staging-synthetic"), "staging", { mode: 0o600 });
  const restored = join(f.base, "restored");
  await cp(f.root, restored, { recursive: true, preserveTimestamps: true });
  await rm(f.root, { recursive: true });
  const r = await audit(restored);
  assert.equal(r.status, "passed", JSON.stringify(r));
  assert.equal(r.counts.active, 1); assert.equal(r.counts.inactive, 1);
  assert.equal(r.counts.orphanBlobs, 1); assert.equal(r.counts.staging, 1);
});
for (const action of ["corrupt", "missing"] as const) test(`${action} inactive source fails without writes`, async t => {
  const f = await fixture(t), path = join(f.root, "blobs", f.docs[0]!.sourceHash);
  if (action === "corrupt") await writeFile(path, "corruption"); else await rm(path);
  const r = await audit(f.root);
  assert.equal(r.status, "failed"); assert.ok(r.issues.some(i => i.code === "source-blob-invalid"));
  assert.ok(!JSON.stringify(r).includes("retained inactive"));
});
for (const version of [0, 1, 99]) test(`schema ${version} refused without upgrades`, async t => {
  const f = await fixture(t), db = new DatabaseSync(join(f.root, "catalog.sqlite"));
  db.exec(`PRAGMA user_version=${version}`); db.close();
  assert.equal((await audit(f.root)).issues[0]?.code, "unsupported-schema");
});
test("missing root, unsafe paths, private modes and sidecars fail closed", async t => {
  const f = await fixture(t);
  const missing = join(f.base, "missing");
  assert.equal((await verifyCollection(missing, { offline: true })).status, "failed");
  await assert.rejects(lstat(missing), { code: "ENOENT" });
  assert.equal((await verifyCollection(f.root, { offline: false })).status, "failed");
  await symlink(f.root, join(f.base, "link"));
  assert.equal((await verifyCollection(join(f.base, "link"), { offline: true })).status, "failed");
  await chmod(join(f.root, "catalog.sqlite"), 0o644);
  assert.equal((await audit(f.root)).status, "failed");
  await chmod(join(f.root, "catalog.sqlite"), 0o600);
  await writeFile(join(f.root, "catalog.sqlite-wal"), "retained state", { mode: 0o600 });
  assert.equal((await audit(f.root)).issues[0]?.code, "sidecar-present-offline-copy-required");
});
test("blob symlink refused and target not modified", async t => {
  const f = await fixture(t), path = join(f.root, "blobs", f.docs[0]!.sourceHash);
  const target = join(f.base, "target");
  await writeFile(target, "private", { mode: 0o600 }); await rm(path); await symlink(target, path);
  assert.equal((await audit(f.root)).status, "failed");
  assert.equal(await readFile(target, "utf8"), "private");
});
test("bounded malformed capture and unexpected schema never certify", async t => {
  const f = await fixture(t);
  let db = new DatabaseSync(join(f.root, "catalog.sqlite"));
  db.prepare("INSERT INTO revisions VALUES (?,?,?)").run(`doc_${sha256("bad")}`, sha256("bad"), "null"); db.close();
  assert.equal((await audit(f.root)).status, "failed");
  db = new DatabaseSync(join(f.root, "catalog.sqlite")); db.exec("CREATE TABLE surprise (payload TEXT)"); db.close();
  assert.equal((await audit(f.root)).issues[0]?.code, "unsupported-schema");
});
test("oversized payload rejected before JSON parsing", async t => {
  const f = await fixture(t), db = new DatabaseSync(join(f.root, "catalog.sqlite"));
  db.prepare("INSERT INTO revisions VALUES (?,?,?)").run(`doc_${sha256("large")}`, sha256("large"), " ".repeat(8_000_001)); db.close();
  assert.equal((await audit(f.root)).issues[0]?.code, "verification-budget-exhausted");
});
test("retained hints and vectors: references, opaque dimension limitation and malformed values", async t => {
  const f = await fixture(t), doc = structuredClone(f.docs[0]!);
  const png = encodePng(1, 1, 3, Buffer.from([10, 20, 30]));
  doc.images.push({ id: "image", blobHash: await f.blobs.put(png), originKind: "embedded_original", locator: { kind: "lines", start: 1, end: 1 }, caption: "", elementIds: ["element_0"] });
  doc.revision = captureRevision(doc);
  await SqliteCatalog.use(f.root, async c => {
    c.publish(doc, c.epoch());
    c.saveHint(createVisionHint(doc, { documentId: doc.id, revision: doc.revision, sourceHash: doc.sourceHash, imageId: "image", blobHash: doc.images[0]!.blobHash, modelFingerprint: sha256("model"), promptFingerprint: sha256("prompt"), description: "synthetic" }), c.epoch());
    c.saveVectors(doc, { provider: "test", model: "test", revision: "1", dimension: 2, queryInstruction: "", documentInstruction: "" }, [[1, 2]], c.epoch());
    c.publish(f.docs[1]!, c.epoch());
  });
  const r = await audit(f.root);
  assert.equal(r.status, "incomplete"); assert.equal(r.counts.hints, 1); assert.equal(r.counts.vectors, 1);
  const db = new DatabaseSync(join(f.root, "catalog.sqlite")); db.exec("UPDATE vectors SET vector='[0,0]'"); db.close();
  assert.ok((await audit(f.root)).issues.some(i => i.code === "vector-invalid"));
});
test("OCR retained render and complete transcript binding, missing transcript", async t => {
  const f = await fixture(t), text = "synthetic OCR 文本";
  const renderHash = await f.blobs.put(encodePng(1, 1, 3, Buffer.from([0, 0, 0])));
  const transcriptHash = await f.blobs.put(Buffer.from(text));
  const p = { kind: "ocr" as const, verification: "unverified" as const, sourceHash: f.docs[0]!.sourceHash, page: 1, pageCount: 1, pageRenderHash: renderHash, transcriptHash, stackFingerprint: sha256("stack"), recipeFingerprint: sha256(OCR_RECIPE), width: 1, height: 1 };
  const input = { ...f.docs[0]!, parserVersion: OCR_PARSER, elements: [{ id: "ocr", text, locator: { kind: "page" as const, page: 1 }, provenance: { ...p, transcriptStart: 0, transcriptEnd: text.length } }], images: [{ id: "render", blobHash: renderHash, locator: { kind: "page" as const, page: 1 }, originKind: "page_render" as const, caption: "", elementIds: ["ocr"], provenance: p }] };
  const doc = { ...input, revision: captureRevision(input) };
  await SqliteCatalog.use(f.root, async c => { c.publish(doc, c.epoch()); c.publish(f.docs[1]!, c.epoch()); });
  assert.equal((await audit(f.root)).status, "passed");
  await rm(join(f.root, "blobs", transcriptHash));
  assert.ok((await audit(f.root)).issues.some(i => i.code === "ocr-transcript-invalid"));
});
for (const format of ["jpeg", "webp"] as const) test(`${format} rendition re-decoding on inactive revision and corrupt display`, async t => {
  const { default: sharp } = await import("sharp");
  const f = await fixture(t);
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })[format]().toBuffer();
  const prepared = await prepareImage(bytes); await storePrepared(prepared, f.blobs);
  const doc = structuredClone(f.docs[0]!);
  doc.images.push({ id: "image", blobHash: sha256(bytes), rendition: prepared.rendition!, locator: { kind: "lines", start: 1, end: 1 }, originKind: "embedded_original", caption: "", elementIds: ["element_0"] });
  doc.revision = captureRevision(doc);
  await SqliteCatalog.use(f.root, async c => { c.publish(doc, c.epoch()); c.publish(f.docs[1]!, c.epoch()); });
  assert.equal((await audit(f.root)).status, "passed");
  await writeFile(join(f.root, "blobs", prepared.rendition!.blobHash), "bad display");
  assert.equal((await audit(f.root)).status, "failed");
});
test("CLI requires explicit offline root, emits bounded JSON and exit status", async t => {
  const f = await fixture(t);
  const before = await snapshot(f.root);
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/verify-collection.mjs", "--offline", "--root", f.root], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).status, "passed");
  assert.deepEqual(await snapshot(f.root), before);
  assert.equal(spawnSync(process.execPath, ["--experimental-strip-types", "scripts/verify-collection.mjs", "--root", f.root]).status, 2);
});

test("WAL-mode header without sidecars refused without SQLite creating files", async t => {
  const f = await fixture(t), db = new DatabaseSync(join(f.root, "catalog.sqlite"));
  db.exec("PRAGMA journal_mode=WAL"); db.close();
  assert.equal((await audit(f.root)).issues[0]?.code, "unsafe-catalog");
});
test("dangling retained vector references fail integrity; dimensions must agree across revisions", async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(join(f.root, "catalog.sqlite"));
  const insert = db.prepare("INSERT INTO vectors VALUES (?,?,?,?,?)");
  for (const [i, doc] of f.docs.entries()) insert.run(doc.id, doc.revision, sha256("space"), "element_0", JSON.stringify(i ? [1, 2] : [1]));
  db.close();
  assert.ok((await audit(f.root)).issues.some(i => i.code === "vector-invalid"));
  const bad = new DatabaseSync(join(f.root, "catalog.sqlite"));
  bad.exec("PRAGMA foreign_keys=OFF");
  bad.prepare("INSERT INTO vectors VALUES (?,?,?,?,?)").run(`doc_${sha256("absent")}`, sha256("absent"), sha256("space"), "element_0", "[1]"); bad.close();
  assert.equal((await audit(f.root)).issues[0]?.code, "catalog-budget-or-integrity");
});
test("row budget is enforced and reports no stored data", async t => {
  const f = await fixture(t), db = new DatabaseSync(join(f.root, "catalog.sqlite"));
  db.exec("BEGIN");
  const insert = db.prepare("INSERT INTO revisions VALUES (?,?,?)");
  for (let i = 0; i < 10_001; i++) insert.run(`doc_${sha256(String(i))}`, sha256("bad"), "null");
  db.exec("COMMIT"); db.close();
  const r = await audit(f.root);
  assert.equal(r.status, "incomplete");
  assert.deepEqual(r.issues, [{ code: "verification-budget-exhausted", count: 1 }]);
  assert.ok(JSON.stringify(r).length < 5000);
});

test("token-equivalent v2 schema passes without persistent writes", async t => {
  const f = await fixture(t);
  // Build a fresh equivalent fixture using the production schema's DDL, not writable_schema.
  const path = join(f.root, "catalog.sqlite");
  const original = new DatabaseSync(path);
  const ddl = original.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type='trigger',name").all();
  original.close();
  await rm(path);
  const db = new DatabaseSync(path);
  db.exec(ddl.map(row => (row.sql as string).replaceAll("TEXT NOT NULL", "text  not null")).join(";\n"));
  db.exec("INSERT INTO metadata VALUES ('epoch',0); PRAGMA user_version=2");
  const insert = db.prepare("INSERT INTO revisions VALUES (?,?,?)");
  for (const doc of f.docs) insert.run(doc.id, doc.revision, JSON.stringify(doc));
  db.close();
  await chmod(path, 0o600);
  const r = await audit(f.root);
  assert.equal(r.status, "passed", JSON.stringify(r));
  assert.equal(r.counts.revisions, 2);
});

test("repeated source hash consumes cumulative read budget and stops without corruption findings", async t => {
  const f = await fixture(t);
  const sourceHash = await f.blobs.put(Buffer.alloc(VERIFICATION_LIMITS.blobBytes, 65));
  const completed = Math.floor(VERIFICATION_LIMITS.totalBlobBytes / VERIFICATION_LIMITS.blobBytes);
  const db = new DatabaseSync(join(f.root, "catalog.sqlite"));
  const insert = db.prepare("INSERT INTO revisions VALUES (?,?,?)");
  db.exec("BEGIN");
  for (let i = 0; i < completed + 2; i++) {
    const input = { ...f.docs[0]!, id: `doc_${sha256(`repeated-${i}`)}`, sourceHash };
    const doc = { ...input, revision: captureRevision(input) };
    insert.run(doc.id, doc.revision, JSON.stringify(doc));
  }
  db.exec("COMMIT"); db.close();
  const r = await audit(f.root);
  assert.equal(r.status, "incomplete");
  assert.deepEqual(r.issues, [{ code: "verification-budget-exhausted", count: 1 }]);
  // Two tiny fixture reads, then 25 complete 20 MiB reads; the next read stops the audit.
  assert.equal(r.counts.revisions, f.docs.length + completed + 1);
  assert.equal(r.counts.blobs, 0, "inventory was not reached");
});

test("cumulative capture items stop immediately even when each capture is valid", async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(join(f.root, "catalog.sqlite"));
  const insert = db.prepare("INSERT INTO revisions VALUES (?,?,?)");
  db.exec("BEGIN");
  for (let i = 0; i < 5; i++) {
    const input = { ...f.docs[0]!, id: `doc_${sha256(`items-${i}`)}`,
      elements: Array.from({ length: 5000 }, (_, n) => ({ ...f.docs[0]!.elements[0]!, id: `element_${n}` })) };
    const doc = { ...input, revision: captureRevision(input) };
    insert.run(doc.id, doc.revision, JSON.stringify(doc));
  }
  db.exec("COMMIT"); db.close();
  const r = await audit(f.root);
  assert.equal(r.status, "incomplete");
  assert.deepEqual(r.issues, [{ code: "verification-budget-exhausted", count: 1 }]);
  assert.equal(r.counts.revisions, 5, "two fixture captures plus three 5000-item captures completed");
  assert.equal(r.counts.blobs, 0, "inventory was not reached");
});

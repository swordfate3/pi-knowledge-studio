import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, symlink, readFile, truncate } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { PdfJobs } from "../src/application/pdf-jobs.ts";
import { fixture } from "./pdf-job-fixture.ts";
import type { EmbeddingProvider } from "../src/domain/retrieval.ts";
const provider = (): EmbeddingProvider => ({ space: { provider: "fixture", model: "synthetic", revision: "1", dimension: 2, queryInstruction: "", documentInstruction: "" }, async embed(texts) { assert.ok(texts.length <= 4); return texts.map(() => [1, 2]); } });
async function setup(pages = 11, bitmap = false) {
  const root = await mkdtemp(join(tmpdir(), "pdf-jobs-")), path = join(root, "book.pdf"), store = join(root, "jobs");
  await writeFile(path, fixture(Array.from({ length: pages }, (_, i) => `Physicalpage${i + 1} synthetic evidence`), bitmap));
  return { root, path, store, jobs: new PdfJobs(store) };
}
test("whole 205-page PDF automatic windows, four-text batches, one book and original pages", { timeout: 180000 }, async () => {
  const { root, path, store, jobs } = await setup(205, true);
  try {
    const m = await jobs.start(root, path); let calls = 0;
    const p = provider(), original = p.embed; p.embed = async (texts, purpose) => { calls++; return original(texts, purpose); };
    const done = await jobs.resume(m.bookId, { provider: p });
    assert.equal(done.state, "ready"); assert.equal(done.parsedPages, 205); assert.equal(calls, 82);
    assert.equal((await new PdfJobs(store).resume(m.bookId, { provider: p })).state, "ready"); assert.equal(calls, 82);
    const result = await jobs.search(m.bookId, "Physicalpage205");
    assert.equal((await jobs.search(m.bookId, "Physicalpage205", 5, undefined, provider())).retrieval, "hybrid-weighted");
    assert.equal(result.hits[0]?.page, 205); assert.equal(result.hits[0]?.bookId, m.bookId); assert.equal(result.hits[0]?.images[0]?.page, 205);
    assert.equal((await jobs.start(root, path)).bookId, m.bookId);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("parse checkpoint cancellation, provider failure, restart, identity drift, no incomplete search", async () => {
  const { root, path, store, jobs } = await setup();
  try {
    const m = await jobs.start(root, path), controller = new AbortController();
    await assert.rejects(jobs.resume(m.bookId, { signal: controller.signal, onProgress: state => { if (state.parsedPages === 5) controller.abort(); } }));
    assert.equal((await jobs.status(m.bookId)).parsedPages, 5);
    await assert.rejects(jobs.search(m.bookId, "synthetic"), /incomplete/);
    const p = provider(); let count = 0;
    p.embed = async texts => { if (++count === 2) throw new Error("synthetic provider failure"); return texts.map(() => [1, 2]); };
    await assert.rejects(new PdfJobs(store).resume(m.bookId, { provider: p }), /provider failure/);
    assert.equal((await jobs.status(m.bookId)).batchOffset, 4);
    const wrong = provider(); wrong.space.revision = "2";
    await assert.rejects(jobs.resume(m.bookId, { provider: wrong }), /identity drift/);
    const invalid = provider(); invalid.embed = async texts => texts.map(() => [NaN, 0]);
    await assert.rejects(jobs.resume(m.bookId, { provider: invalid }), /Invalid PDF job vectors/);
    assert.equal((await jobs.status(m.bookId)).batchOffset, 4);
    assert.equal((await new PdfJobs(store).resume(m.bookId, { provider: provider() })).state, "ready");
    await writeFile(join(store, m.bookId + ".pdf"), "corrupt");
    await assert.rejects(jobs.resume(m.bookId), /identity drift/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("locks reject concurrent resume; unsafe paths and corrupted manifests fail closed", async () => {
  const { root, path, store, jobs } = await setup(1);
  try {
    const m = await jobs.start(root, path); await jobs.resume(m.bookId);
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(r => { release = r; }), entry = new Promise<void>(r => { entered = r; });
    const p = provider(); p.embed = async texts => { entered(); await gate; return texts.map(() => [1, 2]); };
    const pending = jobs.resume(m.bookId, { provider: p }); await entry;
    await assert.rejects(new PdfJobs(store).resume(m.bookId), /locked/); release(); await pending;
    await assert.rejects(jobs.status("../escape"), /Invalid book ID/);
    const link = join(root, "linked.pdf"); await symlink(path, link);
    await assert.rejects(jobs.start(root, link), /Symlink/);
    const db = new DatabaseSync(join(store, m.bookId + ".sqlite"));
    db.prepare("UPDATE manifest SET json=?").run(JSON.stringify({ ...await jobs.status(m.bookId), extra: true })); db.close();
    await assert.rejects(jobs.status(m.bookId), /Invalid PDF job record/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("worker window failure retains prior window; explicit input quota and symlink spool rejection", async () => {
  const { root, path, store, jobs } = await setup(6);
  try {
    // Last page invalid content font size produces no failure in PDF.js; instead use excessive extracted page text.
    await writeFile(path, fixture([...Array.from({ length: 5 }, () => "valid page"), "x".repeat(110000)], false, ".0001"));
    const m = await jobs.start(root, path);
    await assert.rejects(jobs.resume(m.bookId), /budget|timeout|parsing failed/i);
    assert.equal((await jobs.status(m.bookId)).parsedPages, 5);
    await assert.rejects(jobs.resume(m.bookId), /budget|timeout|parsing failed/i);
    assert.equal((await jobs.status(m.bookId)).parsedPages, 5);
    await assert.rejects(new PdfJobs(join(root, "tiny"), { maxInputBytes: 20, maxStorageBytes: 2000000 }).start(root, path), /input quota/);
    const spool = join(store, m.bookId + ".pdf"); await rm(spool); await symlink(path, spool);
    await assert.rejects(jobs.status(m.bookId), /ELOOP|private/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("rollback orphan batch after process death is recovered without poisoning previous job", async () => {
  const { root, path, store, jobs } = await setup(1);
  try {
    const m = await jobs.start(root, path); await jobs.resume(m.bookId);
    const { spawn } = await import("node:child_process");
    const script = `const {DatabaseSync}=require('node:sqlite'); const lock=new DatabaseSync(process.argv[1]+'.lock');lock.exec('BEGIN IMMEDIATE');const db=new DatabaseSync(process.argv[1]+'.sqlite');db.exec('BEGIN IMMEDIATE');db.prepare('INSERT INTO batches VALUES (?,?,?,?)').run(1,0,'[[1,2]]','orphan');process.stdout.write('pending');setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ["-e", script, join(store, m.bookId)], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); child.once("exit", code => { if (code !== null) reject(new Error(`child exited ${code}`)); }); });
    await new Promise<void>(resolve => { child.once("close", () => resolve()); child.kill("SIGKILL"); });
    assert.equal((await new PdfJobs(store).resume(m.bookId, { provider: provider() })).state, "ready");
    // Existing ready job must survive a different corrupt job.
    await writeFile(path, fixture(["different"])); const other = await jobs.start(root, path);
    const db = new DatabaseSync(join(store, other.bookId + ".sqlite")); db.exec("UPDATE manifest SET json='{}'"); db.close();
    await assert.rejects(jobs.resume(other.bookId));
    assert.equal((await jobs.search(m.bookId, "synthetic")).hits.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("storage quota fails transactionally; finite vector tampering fails checksum", async () => {
  const { root, path, store, jobs } = await setup(6);
  try {
    await writeFile(path, fixture(Array.from({ length: 6 }, () => "x".repeat(90000)), false, ".0001"));
    const tiny = new PdfJobs(join(root, "quota"), { maxInputBytes: 600000, maxStorageBytes: 1650000 });
    const limited = await tiny.start(root, path);
    await assert.rejects(tiny.resume(limited.bookId), /full|quota/i);
    assert.equal((await tiny.status(limited.bookId)).parsedPages, 0);
    await writeFile(path, fixture(["normal"])); const m = await jobs.start(root, path);
    await jobs.resume(m.bookId, { provider: provider() });
    const db = new DatabaseSync(join(store, m.bookId + ".sqlite"));
    db.exec("UPDATE batches SET json='[[2,3]]'"); db.close();
    await assert.rejects(jobs.status(m.bookId), /binding mismatch/);
    await assert.rejects(jobs.resume(m.bookId, { provider: provider() }), /binding mismatch/);
    await assert.rejects(jobs.search(m.bookId, "normal"), /binding mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("exact schema rejects poison triggers, views, unknown tables and lock schema without changing files", async () => {
  for (const [suffix, sql] of [
    [".sqlite", "CREATE TRIGGER poison AFTER INSERT ON batches BEGIN DELETE FROM windows; END"],
    [".sqlite", "CREATE VIEW poison AS SELECT * FROM manifest"],
    [".sqlite", "CREATE TABLE unknown(value TEXT)"],
    [".lock", "CREATE TABLE poison(value TEXT)"],
    [".sqlite", "DROP TABLE images; CREATE TABLE images(hash TEXT PRIMARY KEY,bytes TEXT NOT NULL)"],
  ]) {
    const { root, path, store, jobs } = await setup(1);
    try {
      const m = await jobs.start(root, path); await jobs.resume(m.bookId);
      const prefix = join(store, m.bookId), db = new DatabaseSync(prefix + suffix);
      db.exec(sql!); db.close();
      const before = await Promise.all([".sqlite", ".lock", ".pdf"].map(ext => readFile(prefix + ext)));
      await assert.rejects(jobs.resume(m.bookId, { provider: provider() }), /schema/);
      await assert.rejects(jobs.start(root, path), /schema/);
      await assert.rejects(jobs.status(m.bookId), /schema/);
      const after = await Promise.all([".sqlite", ".lock", ".pdf"].map(ext => readFile(prefix + ext)));
      assert.deepEqual(after, before);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
test("SQL predicates reject oversized manifest/window/batch/image values before returning them", async () => {
  const { root, path, store, jobs } = await setup(1, true);
  try {
    const m = await jobs.start(root, path); await jobs.resume(m.bookId, { provider: provider() });
    const file = join(store, m.bookId + ".sqlite"), original = await readFile(file);
    for (const sql of [
      "UPDATE manifest SET json=CAST(zeroblob(8388609) AS TEXT)",
      "UPDATE windows SET json=CAST(zeroblob(8388609) AS TEXT)",
      "UPDATE windows SET hash=CAST(zeroblob(8388609) AS TEXT)",
      "UPDATE batches SET json=CAST(zeroblob(8388609) AS TEXT)",
      "UPDATE batches SET binding=CAST(zeroblob(8388609) AS TEXT)",
      "UPDATE images SET bytes=zeroblob(20971521)",
    ]) {
      const db = new DatabaseSync(file); db.exec(sql); db.close();
      const before = await readFile(file);
      await assert.rejects(jobs.status(m.bookId), /JSON size|binding mismatch|image checksum/);
      assert.deepEqual(await readFile(file), before);
      await writeFile(file, original);
    }
    // Existing empty databases are not silently adopted/initialized.
    await truncate(file, 0);
    await assert.rejects(jobs.start(root, path), /schema/);
    assert.equal((await readFile(file)).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("physical database quota is checked before reading manifest or verifying source", async () => {
  const { root, path, store } = await setup(1);
  try {
    const jobs = new PdfJobs(store, { maxInputBytes: 100000, maxStorageBytes: 2000000 });
    const m = await jobs.start(root, path), file = join(store, m.bookId + ".sqlite");
    const db = new DatabaseSync(file); db.exec("UPDATE manifest SET json='{}'"); db.close();
    await truncate(file, 1000000); // Beyond the pre-manifest half-budget; sparse, no JS allocation.
    await assert.rejects(jobs.status(m.bookId), /storage quota/);
    await assert.rejects(jobs.resume(m.bookId), /storage quota/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unchanged original v1 IF NOT EXISTS schema stays compatible", async () => {
  const { root, path, store, jobs } = await setup(1);
  try {
    const m = await jobs.start(root, path), db = new DatabaseSync(join(store, m.bookId + ".sqlite"));
    db.exec("DROP TABLE windows; DROP TABLE batches; DROP TABLE images; CREATE TABLE IF NOT EXISTS windows(start INTEGER PRIMARY KEY,json TEXT NOT NULL,hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS batches(start INTEGER,offset INTEGER,json TEXT NOT NULL,binding TEXT NOT NULL,PRIMARY KEY(start,offset)); CREATE TABLE IF NOT EXISTS images(hash TEXT PRIMARY KEY,bytes BLOB NOT NULL)");
    db.close();
    assert.equal((await jobs.status(m.bookId)).version, "native-pdf-job-v1");
    assert.equal((await jobs.resume(m.bookId, { provider: provider() })).state, "ready");
  } finally { await rm(root, { recursive: true, force: true }); }
});

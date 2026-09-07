import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm, stat, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PdfJobs } from "../src/application/pdf-jobs.ts";
import { PdfGenerations, profileSpace, profileProvider } from "../src/application/pdf-generation-store.ts";
import type { ModelProfile, ProfileInput } from "../src/application/pdf-generation-store.ts";
import type { EmbeddingProvider } from "../src/domain/retrieval.ts";
import { fixture } from "./pdf-job-fixture.ts";
const input = (id = "fixture"): ProfileInput => ({ id, endpoint: "http://127.0.0.1:7777/embeddings", kind: "openai", space: { provider: "fixture", model: "synthetic", revision: "1", dimension: 2, queryInstruction: "", documentInstruction: "" }, credentialEnv: null });
function provider(p: ModelProfile): EmbeddingProvider { return { space: profileSpace(p), async embed(texts) { assert.ok(texts.length <= 4); return texts.map(() => [1, 2]); } }; }
const quotas = { maxInputBytes: 2 * 1024 * 1024, maxStorageBytes: 32 * 1024 * 1024 };
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pdf-generations-")), legacy = join(root, "legacy"), path = join(root, "source.pdf"), destination = join(root, "generations");
  await writeFile(path, fixture(Array.from({ length: 6 }, (_, i) => `Physicalpage${i + 1} synthetic evidence`), true));
  const old = new PdfJobs(legacy, quotas), m = await old.start(root, path), p = { ...input(), revision: 1 };
  await old.resume(m.bookId, { provider: provider(p) });
  const store = new PdfGenerations(destination, quotas), imported = await store.importLegacy(legacy, m.bookId), profile = await store.addProfile(input());
  await store.selectProfile(profile.id, profile.revision);
  return { root, legacy, destination, old, m, store, profile, imported };
}
function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { release, promise }; }

test("source capture import preserves exact legacy identity/files/images; profile revisions and default don't alter active queries", async () => {
  const x = await setup();
  try {
    const before = await Promise.all([".pdf", ".sqlite", ".lock"].map(ext => readFile(join(x.legacy, x.m.bookId + ext))));
    const p2 = await x.store.addProfile({ ...input(), space: { ...input().space, model: "second" } });
    await x.store.selectProfile(p2.id, p2.revision);
    assert.equal(p2.revision, 2);
    const result = await x.store.search(x.m.bookId, "Physicalpage6", 5, provider(x.profile));
    assert.equal(result.hits[0]?.page, 6); assert.equal(result.hits[0]?.images[0]?.page, 6);
    assert.equal(result.space.provider, "fixture|openai|http://127.0.0.1:7777/embeddings");
    assert.equal(result.generationId, x.imported.book.active);
    const next = await new PdfGenerations(x.destination, quotas).selectedProfile(); assert.equal(next.revision, 2);
    await assert.rejects(x.store.search(x.m.bookId, "synthetic", 5, provider(p2)), /identity drift/);
    await assert.rejects(x.store.importLegacy(x.legacy, x.m.bookId), /already imported/);
    assert.deepEqual(await Promise.all([".pdf", ".sqlite", ".lock"].map(ext => readFile(join(x.legacy, x.m.bookId + ext)))), before);
  } finally { await rm(x.root, { recursive: true, force: true }); }
});

test("A search/status/cancel stay available while B HTTP is blocked; stale result fenced and same-space generations isolated", async () => {
  const x = await setup(), entered = gate(), release = gate();
  try {
    const b = await x.store.reindex(x.m.bookId, x.profile, true), p = provider(x.profile);
    p.embed = async texts => { entered.release(); await release.promise; return texts.map(() => [9, 1]); };
    const pending = x.store.resume(b.id, p, true); const rejected = assert.rejects(pending, /fenced/); await entered.promise;
    const other = new PdfGenerations(x.destination, quotas);
    assert.equal((await other.status(x.m.bookId)).generations.find(g => g.id === b.id)?.checkpoint, 0);
    assert.equal((await other.search(x.m.bookId, "synthetic")).generationId, x.imported.book.active);
    await assert.rejects(other.resume(b.id, provider(x.profile), true), /already running/);
    assert.equal((await other.stop(b.id, "cancelled")).state, "cancelled");
    release.release(); await rejected;
    const status = await other.status(x.m.bookId); assert.equal(status.generations.find(g => g.id === b.id)?.checkpoint, 0);
    await assert.rejects(other.resume(b.id, provider(x.profile), true), /terminal/);
    assert.equal((await other.search(x.m.bookId, "synthetic")).generationId, x.imported.book.active);
  } finally { release.release(); await rm(x.root, { recursive: true, force: true }); }
});

test("failure checkpoints survive restart, explicit retry uses immutable snapshot; activation CAS and rollback retain both spaces", async () => {
  const x = await setup();
  try {
    const b = await x.store.reindex(x.m.bookId, x.profile, true), p = provider(x.profile); let calls = 0;
    p.embed = async texts => { if (++calls === 2) throw new Error("synthetic failure"); return texts.map(() => [1, 2]); };
    await assert.rejects(x.store.resume(b.id, p, true), /synthetic failure/);
    assert.equal((await x.store.generationSnapshot(b.id)).checkpoint, 1);
    const p2 = await x.store.addProfile({ ...input(), space: { ...input().space, revision: "2" } }); await x.store.selectProfile(p2.id, p2.revision);
    assert.equal((await x.store.generationSnapshot(b.id)).profile?.revision, 1);
    const restarted = new PdfGenerations(x.destination, quotas);
    await assert.rejects(restarted.resume(b.id, provider(p2), true), /identity drift/);
    let retried = 0; const good = provider(x.profile); good.embed = async texts => { retried++; return texts.map(() => [1, 2]); };
    const done = await restarted.resume(b.id, good, true); assert.equal(done.state, "ready"); assert.equal(retried, 2);
    assert.equal((await restarted.status(x.m.bookId)).book.active, x.imported.book.active);
    await assert.rejects(restarted.activate(x.m.bookId, b.id, null, 0), /CAS conflict/);
    const active = await restarted.activate(x.m.bookId, b.id, x.imported.book.active, 1); assert.equal(active.epoch, 2);
    assert.equal((await restarted.search(x.m.bookId, "synthetic")).generationId, b.id);
    const rolled = await restarted.activate(x.m.bookId, x.imported.book.active!, b.id, 2); assert.equal(rolled.epoch, 3);
    await assert.rejects(restarted.activate(x.m.bookId, b.id, x.imported.book.active, 1), /CAS conflict/);
    assert.equal((await restarted.search(x.m.bookId, "synthetic")).generationId, x.imported.book.active);
  } finally { await rm(x.root, { recursive: true, force: true }); }
});

test("pause during HTTP discards result; explicit resume and mid-call provider drift fail closed", async () => {
  const x = await setup(), entered = gate(), release = gate();
  try {
    const b = await x.store.reindex(x.m.bookId, x.profile, true), p = provider(x.profile);
    p.embed = async texts => { entered.release(); await release.promise; return texts.map(() => [1, 2]); };
    const pending = assert.rejects(x.store.resume(b.id, p, true), /fenced/); await entered.promise;
    await x.store.stop(b.id, "paused"); release.release(); await pending;
    const drift = provider(x.profile); drift.embed = async texts => { drift.space.model = "changed"; return texts.map(() => [1, 2]); };
    await assert.rejects(x.store.resume(b.id, drift, true), /identity drift/);
    assert.equal((await x.store.generationSnapshot(b.id)).checkpoint, 0);
    assert.equal((await x.store.resume(b.id, provider(x.profile), true)).state, "ready");
  } finally { release.release(); await rm(x.root, { recursive: true, force: true }); }
});

test("explicit crash recovery takes over expired durable lease without replaying committed batch", async () => {
  const x = await setup();
  try {
    const b = await x.store.reindex(x.m.bookId, x.profile, true);
    const { spawn } = await import("node:child_process");
    const script = `import {PdfGenerations,profileSpace} from ${JSON.stringify(new URL("../src/application/pdf-generation-store.ts", import.meta.url).href)};const store=new PdfGenerations(process.argv[1],JSON.parse(process.argv[3]));const g=await store.generationSnapshot(process.argv[2]);let calls=0;await store.resume(g.id,{space:profileSpace(g.profile),async embed(texts){if(++calls===2){process.stdout.write('blocked');await new Promise(()=>{});}return texts.map(()=>[1,2]);}},true);`;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, x.destination, b.id, JSON.stringify(quotas)], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = ""; child.stderr.on("data", d => { stderr += d; });
    await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); child.once("exit", code => reject(new Error(`child ${code}: ${stderr}`))); });
    await new Promise<void>(resolve => { child.once("close", () => resolve()); child.kill("SIGKILL"); });
    assert.equal((await x.store.generationSnapshot(b.id)).checkpoint, 1);
    await assert.rejects(x.store.resume(b.id, provider(x.profile), true), /already running/);
    // Deterministic fixture clock expiry, not a production recovery bypass.
    const db = new DatabaseSync(join(x.destination, "registry.sqlite"));
    const r = JSON.parse(String(db.prepare("SELECT json FROM registry").get()!.json)); r.generations.find((g: { id: string }) => g.id === b.id).lease.until = 0;
    db.prepare("UPDATE registry SET json=?").run(JSON.stringify(r)); db.close();
    let calls = 0; const p = provider(x.profile); p.embed = async texts => { calls++; return texts.map(() => [1, 2]); };
    assert.equal((await new PdfGenerations(x.destination, quotas).resume(b.id, p, true)).state, "ready"); assert.equal(calls, 2);
  } finally { await rm(x.root, { recursive: true, force: true }); }
});

test("legacy 0755/0644 import is read-only and exact-schema checked; original identity is never reconstructed", async () => {
  const x = await setup();
  try {
    // Create mode-0755/0644 copies, never chmod existing originals.
    const publicRoot = join(x.root, "public"); await mkdir(publicRoot, { mode: 0o755 });
    for (const ext of [".pdf", ".sqlite", ".lock"]) await writeFile(join(publicRoot, x.m.bookId + ext), await readFile(join(x.legacy, x.m.bookId + ext)), { mode: 0o644 });
    const before = await Promise.all([".pdf", ".sqlite", ".lock"].map(ext => readFile(join(publicRoot, x.m.bookId + ext))));
    const imported = await new PdfGenerations(join(x.root, "public-import"), quotas).importLegacy(publicRoot, x.m.bookId);
    assert.equal(imported.manifest.space?.provider, "fixture|openai|http://127.0.0.1:7777/embeddings");
    assert.equal((await stat(publicRoot)).mode & 0o777, 0o755);
    assert.equal((await stat(join(publicRoot, x.m.bookId + ".sqlite"))).mode & 0o777, 0o644);
    assert.deepEqual(await Promise.all([".pdf", ".sqlite", ".lock"].map(ext => readFile(join(publicRoot, x.m.bookId + ext)))), before);
    const db = new DatabaseSync(join(publicRoot, x.m.bookId + ".sqlite")); db.exec("CREATE TABLE poison(x)"); db.close();
    const poison = await readFile(join(publicRoot, x.m.bookId + ".sqlite"));
    await assert.rejects(new PdfGenerations(join(x.root, "poison"), quotas).importLegacy(publicRoot, x.m.bookId), /schema/);
    assert.deepEqual(await readFile(join(publicRoot, x.m.bookId + ".sqlite")), poison);
  } finally { await rm(x.root, { recursive: true, force: true }); }
});

test("malformed registry/schema, symlinks, quota and vector binding drift reject without affecting legacy", async () => {
  const x = await setup();
  try {
    const file = join(x.destination, "registry.sqlite"), original = await readFile(file);
    for (const sql of ["UPDATE registry SET json='{}'", "CREATE TABLE poison(value)", "UPDATE vectors SET json='[[2,3],[2,3],[2,3],[2,3]]'"]) {
      const db = new DatabaseSync(file); db.exec(sql); db.close();
      if (sql.includes("vectors")) await assert.rejects(x.store.search(x.m.bookId, "synthetic"), /binding drift/);
      else await assert.rejects(x.store.status(x.m.bookId));
      await writeFile(file, original);
    }
    await symlink(x.destination, join(x.root, "linked")); await assert.rejects(new PdfGenerations(join(x.root, "linked"), quotas).profiles());
    const other = join(x.root, "unsafe"); await mkdir(other, { mode: 0o700 }); await symlink(file, join(other, "registry.sqlite")); await assert.rejects(new PdfGenerations(other, quotas).profiles());
    await assert.rejects(new PdfGenerations(join(x.root, "tiny"), { maxInputBytes: 10, maxStorageBytes: 2 * 1024 * 1024 }).importLegacy(x.legacy, x.m.bookId), /quota/);
    assert.equal((await x.old.search(x.m.bookId, "synthetic")).hits.length, 5);
  } finally { await rm(x.root, { recursive: true, force: true }); }
});

test("profile egress denial, credentials only from explicit env reference, endpoint validation and no plaintext storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdf-profile-"));
  try {
    const store = new PdfGenerations(join(root, "store"), quotas);
    const p = await store.addProfile({ ...input(), credentialEnv: "PI_KS_PROFILE_TEST_KEY" });
    const trustedEnv = Object.freeze({ PI_KS_PROFILE_TEST_KEY: "secret-marker-DO-NOT-PERSIST" });
    assert.throws(() => profileProvider(p, trustedEnv, "document", false), /denied/);
    assert.throws(() => profileProvider(p, {}, "document", true), /unavailable/);
    assert.equal(profileProvider(p, trustedEnv, "document", true).space.provider, profileSpace(p).provider);
    await assert.rejects(store.addProfile({ ...input(), apiKey: "plaintext" } as ProfileInput), /record/);
    await assert.rejects(store.addProfile({ ...input(), credentialEnv: "PATH" }), /environment/);
    for (const endpoint of ["http://example.com/emb", "https://user:key@example.com/emb", "https://example.com/emb?key=x", "https://example.com/emb#key"]) await assert.rejects(store.addProfile({ ...input(), endpoint }), /endpoint/);
    assert.equal((await readFile(join(root, "store", "registry.sqlite"))).includes(Buffer.from(trustedEnv.PI_KS_PROFILE_TEST_KEY)), false);
    assert.equal(JSON.stringify(await store.profiles()).includes(trustedEnv.PI_KS_PROFILE_TEST_KEY), false);
    await assert.rejects(store.reindex("missing", p, false), /denied/);
    await assert.rejects(store.resume("missing", provider(p), false), /denied/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("trimmed lexical tokens never match unrelated text", async () => {
  const x = await setup();
  try { assert.deepEqual((await x.store.search(x.m.bookId, " nonexistent-token \t")).hits, []); }
  finally { await rm(x.root, { recursive: true, force: true }); }
});

test("stop before dispatch prevents provider entry; dispatch holds shared control boundary", async () => {
  const x = await setup();
  try {
    const b = await x.store.reindex(x.m.bookId, x.profile, true), entered = gate(), release = gate();
    // Suspend metadata traversal after lease acquisition but before dispatch authorization.
    const original = PdfJobs.prototype.inspect;
    PdfJobs.prototype.inspect = async function (...args) { const result = await original.apply(this, args); entered.release(); await release.promise; return result; };
    let calls = 0; const p = provider(x.profile); p.embed = async texts => { calls++; return texts.map(() => [1, 2]); };
    const pending = assert.rejects(x.store.resume(b.id, p, true), /fenced/);
    try { await entered.promise; await new PdfGenerations(x.destination, quotas).stop(b.id, "paused"); }
    finally { PdfJobs.prototype.inspect = original; release.release(); }
    await pending; assert.equal(calls, 0);
    p.embed = async texts => {
      const db = new DatabaseSync(join(x.destination, "registry.sqlite"));
      try { assert.throws(() => db.exec("BEGIN IMMEDIATE"), /locked/); } finally { db.close(); }
      return texts.map(() => [1, 2]);
    };
    assert.equal((await x.store.resume(b.id, p, true)).state, "ready");
  } finally { await rm(x.root, { recursive: true, force: true }); }
});

test("profile errors redact malformed headers and throwing transport causes offline", async () => {
  const x = await setup(), original = globalThis.fetch, marker = "secret-marker";
  try {
    const p = await x.store.addProfile({ ...input(), credentialEnv: "PI_KS_PROFILE_TEST_KEY" });
    let calls = 0;
    globalThis.fetch = async (url, init) => { calls++; new Request(url, init); throw new Error(marker, { cause: new Error(marker) }); };
    const safe = (error: unknown) => { assert.ok(error instanceof Error); assert.equal(error.cause, undefined); assert.ok(!String(error.stack).includes(marker)); return true; };
    assert.throws(() => profileProvider(p, { PI_KS_PROFILE_TEST_KEY: marker + "\ntrailing" }, "query", true), safe);
    assert.equal(calls, 0);
    await assert.rejects(x.store.search(x.m.bookId, "synthetic", 5, profileProvider(p, { PI_KS_PROFILE_TEST_KEY: marker }, "query", true)), safe);
    const b = await x.store.reindex(x.m.bookId, p, true);
    await assert.rejects(x.store.resume(b.id, profileProvider(p, { PI_KS_PROFILE_TEST_KEY: marker }, "document", true), true), safe);
    assert.equal(calls, 2);
    assert.ok(!(await readFile(join(x.destination, "registry.sqlite"))).includes(Buffer.from(marker)));
  } finally { globalThis.fetch = original; await rm(x.root, { recursive: true, force: true }); }
});

test("metadata inspection never parses vectors; small streaming budget rejects before later poisoned batches", async () => {
  const x = await setup();
  try {
    const db = new DatabaseSync(join(x.legacy, x.m.bookId + ".sqlite"));
    db.exec("UPDATE batches SET json='not JSON' WHERE start=6"); db.close();
    let windows = 0, batches = 0;
    await x.old.inspect(x.m.bookId, () => { windows++; }); assert.equal(windows, 2);
    await assert.rejects(x.old.inspect(x.m.bookId, () => {}, { vectors: { maxBytes: 1, visit: () => { batches++; } } }), /working-set quota/);
    assert.equal(batches, 0);
  } finally { await rm(x.root, { recursive: true, force: true }); }
});

test("interrupted empty and schema-only initialization recover; populated orphan does not", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-init-"));
  const schema = "CREATE TABLE registry(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL); CREATE TABLE vectors(generation TEXT,ordinal INTEGER,json TEXT NOT NULL,binding TEXT NOT NULL,PRIMARY KEY(generation,ordinal))";
  try {
    for (const kind of ["empty", "schema", "orphan"]) {
      const path = join(root, kind); await mkdir(path, { mode: 0o700 });
      const file = join(path, "registry.sqlite"); await writeFile(file, "", { mode: 0o600 });
      if (kind !== "empty") { const db = new DatabaseSync(file); db.exec(schema); if (kind === "orphan") db.exec("INSERT INTO vectors VALUES('x',0,'[]','x')"); db.close(); }
      const stores = [new PdfGenerations(path, quotas), new PdfGenerations(path, quotas)];
      if (kind === "orphan") { await assert.rejects(stores[0]!.profiles(), /contains vectors/); continue; }
      const results = await Promise.allSettled(stores.map(s => s.profiles()));
      for (const result of results) if (result.status === "rejected") assert.match(String(result.reason), /locked/);
      assert.deepEqual((await stores[0]!.profiles()).profiles, []);
      const db = new DatabaseSync(file); assert.equal(db.prepare("SELECT count(*) AS n FROM registry").get()?.n, 1); db.close();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy association freezes only explicitly approved exact identity and preserves old hybrid during B", async () => {
  const x = await setup(), entered = gate(), release = gate();
  try {
    const a = x.imported.book.active!;
    await assert.rejects(x.store.associateProfile(a, x.profile, false), /approval/);
    for (const change of [{ endpoint: "http://127.0.0.1:7778/embeddings" }, { kind: "wemm" as const }, ...["provider", "model", "revision", "queryInstruction", "documentInstruction"].map(key => ({ space: { ...input().space, [key]: "mismatch" } })), { space: { ...input().space, dimension: 3 } }]) {
      const mismatch = await x.store.addProfile({ ...input(), ...change });
      await assert.rejects(x.store.associateProfile(a, mismatch, true), /identity mismatch/);
    }
    await x.store.associateProfile(a, x.profile, true);
    assert.equal((await x.store.search(x.m.bookId, "synthetic", 5, provider(x.profile))).generationId, a);
    const next = await x.store.addProfile({ ...input(), space: { ...input().space, model: "B" } }); await x.store.selectProfile(next.id, next.revision);
    const b = await x.store.reindex(x.m.bookId, next, true), p = provider(next);
    p.embed = async texts => { entered.release(); await release.promise; return texts.map(() => [1, 2]); };
    const pending = assert.rejects(x.store.resume(b.id, p, true), /fenced/); await entered.promise;
    assert.equal((await x.store.generationSnapshot(a)).profile?.revision, 1);
    assert.equal((await x.store.search(x.m.bookId, "synthetic", 5, provider(x.profile))).generationId, a);
    await x.store.stop(b.id, "cancelled"); release.release(); await pending;
  } finally { release.release(); await rm(x.root, { recursive: true, force: true }); }
});

test("crash at file creation and transactional schema-before-row leaves retryable registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-crash-"));
  try {
    const { spawn } = await import("node:child_process");
    for (const phase of ["file", "schema"]) {
      const path = join(root, phase); await mkdir(path, { mode: 0o700 });
      const script = `import {writeFileSync} from 'node:fs';import {DatabaseSync} from 'node:sqlite';writeFileSync(process.argv[1],'',{mode:0o600});if(process.argv[2]==='schema'){const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE; CREATE TABLE registry(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL); CREATE TABLE vectors(generation TEXT,ordinal INTEGER,json TEXT NOT NULL,binding TEXT NOT NULL,PRIMARY KEY(generation,ordinal))');}process.stdout.write('fault');setInterval(()=>{},1000);`;
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, join(path, "registry.sqlite"), phase], { stdio: ["ignore", "pipe", "pipe"] });
      await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); child.once("exit", () => reject(new Error("fixture exited early"))); });
      await new Promise<void>(resolve => { child.once("close", () => resolve()); child.kill("SIGKILL"); });
      assert.deepEqual((await new PdfGenerations(path, quotas).profiles()).profiles, []);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("many streamed batches reject before allocating remaining vector payloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "vectors-budget-"));
  try {
    const path = join(root, "source.pdf"); await writeFile(path, fixture(Array.from({ length: 80 }, () => "synthetic evidence"), false));
    const old = new PdfJobs(join(root, "legacy"), quotas), m = await old.start(root, path), p = { ...input(), revision: 1 };
    await old.resume(m.bookId, { provider: provider(p) });
    let visited = 0;
    const original = JSON.parse;
    let parsedVectors = 0;
    JSON.parse = function (text: string, reviver?) { if (text.startsWith("[[")) parsedVectors++; return original(text, reviver); };
    try {
      await assert.rejects(old.inspect(m.bookId, () => {}, { vectors: { maxBytes: 1000, visit: () => { visited++; } } }), /working-set quota/);
      assert.ok(visited > 0 && visited < 32); assert.equal(parsedVectors, visited);
    } finally { JSON.parse = original; }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("dispatch rejection is consumed even when subsequent control commit fails", async () => {
  const x = await setup();
  try {
    const b = await x.store.reindex(x.m.bookId, x.profile, true), p = provider(x.profile), original = DatabaseSync.prototype.exec;
    let fail = false;
    DatabaseSync.prototype.exec = function (sql: string) { if (fail && sql === "COMMIT") { fail = false; throw new Error("commit fault"); } return original.call(this, sql); };
    p.embed = () => { fail = true; return Promise.reject(new Error("pending transport failure")); };
    try { await assert.rejects(x.store.resume(b.id, p, true), /commit fault/); await new Promise(resolve => setImmediate(resolve)); }
    finally { DatabaseSync.prototype.exec = original; }
    assert.equal((await x.store.generationSnapshot(b.id)).checkpoint, 0);
  } finally { await rm(x.root, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { CATALOG_SCHEMA_VERSION } from "../src/adapters/storage/catalog-schema.ts";
import { SqliteCatalog } from "../src/adapters/storage/sqlite-catalog.ts";

// Frozen legacy fixture, not produced by downgrading the current initializer.
const legacy = `
CREATE TABLE IF NOT EXISTS revisions (document_id TEXT NOT NULL, revision TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(document_id,revision));
CREATE TRIGGER IF NOT EXISTS revisions_immutable_update BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT, 'Immutable revision: UPDATE forbidden'); END;
CREATE TRIGGER IF NOT EXISTS revisions_immutable_delete BEFORE DELETE ON revisions BEGIN SELECT RAISE(ABORT, 'Immutable revision: DELETE forbidden'); END;
CREATE TABLE IF NOT EXISTS active (document_id TEXT PRIMARY KEY, revision TEXT NOT NULL, FOREIGN KEY(document_id,revision) REFERENCES revisions(document_id,revision));
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS hints (id TEXT PRIMARY KEY NOT NULL, document_id TEXT NOT NULL, revision TEXT NOT NULL, payload TEXT NOT NULL, FOREIGN KEY(document_id,revision) REFERENCES revisions(document_id,revision));
CREATE TRIGGER IF NOT EXISTS hints_immutable_insert BEFORE INSERT ON hints WHEN EXISTS (SELECT 1 FROM hints WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT, 'Immutable hint: replacement forbidden'); END;
CREATE TRIGGER IF NOT EXISTS hints_immutable_update BEFORE UPDATE ON hints BEGIN SELECT RAISE(ABORT, 'Immutable hint: UPDATE forbidden'); END;
CREATE TRIGGER IF NOT EXISTS hints_immutable_delete BEFORE DELETE ON hints BEGIN SELECT RAISE(ABORT, 'Immutable hint: DELETE forbidden'); END;
CREATE TABLE IF NOT EXISTS vectors (document_id TEXT NOT NULL, revision TEXT NOT NULL, space TEXT NOT NULL, element_id TEXT NOT NULL, vector TEXT NOT NULL, PRIMARY KEY(document_id,revision,space,element_id), FOREIGN KEY(document_id,revision) REFERENCES revisions(document_id,revision));
INSERT OR IGNORE INTO metadata VALUES ('epoch',0);
`;

const workerSource = `
import { DatabaseSync } from "node:sqlite";
import { SqliteCatalog } from ${JSON.stringify(new URL("../src/adapters/storage/sqlite-catalog.ts", import.meta.url).href)};
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) {
  if (sql === "BEGIN IMMEDIATE") process.send({ phase: "entering" });
  return exec.call(this, sql);
};
process.send({ phase: "ready" });
process.once("message", async () => {
  let called = false;
  try {
    const result = await SqliteCatalog.use(process.env.CATALOG_ROOT, async (catalog) => {
      called = true;
      return { epoch: catalog.epoch(), version: catalog.db.prepare("PRAGMA user_version").get().user_version };
    });
    process.send({ phase: "done", called, ...result });
  } catch (error) {
    process.send({ phase: "done", called, error: error.message });
  } finally { process.disconnect(); }
});
`;

type Message = { phase: string; called?: boolean; epoch?: number; version?: number; error?: string };
function worker(root: string) {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", workerSource], {
    env: { ...process.env, CATALOG_ROOT: root },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
  const messages = new Map<string, Message>();
  const listeners = new Map<string, (message: Message) => void>();
  child.on("message", (message: Message) => {
    messages.set(message.phase, message);
    listeners.get(message.phase)?.(message);
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return {
    start: () => child.send("go"),
    has: (phase: string) => messages.has(phase),
    async wait(phase: string): Promise<Message> {
      const found = messages.get(phase);
      if (found) return found;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Worker missing ${phase}: ${stderr}`)), 12_000);
        listeners.set(phase, (message) => { clearTimeout(timer); listeners.delete(phase); resolve(message); });
      });
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    },
  };
}

async function isolated(version: number | undefined, operation: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "catalog-concurrency-"));
  try {
    if (version !== undefined) {
      const db = new DatabaseSync(join(root, "catalog.sqlite"));
      try { db.exec(legacy + `PRAGMA user_version=${version}; UPDATE metadata SET value=43;`); }
      finally { db.close(); }
      await chmod(join(root, "catalog.sqlite"), 0o600);
    }
    await operation(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("independent child processes simultaneously open fresh, legacy and v1 catalogs", { timeout: 30_000 }, async () => {
  for (const version of [undefined, 0, 1]) await isolated(version, async (root) => {
    const workers = Array.from({ length: 4 }, () => worker(root));
    try {
      await Promise.all(workers.map((child) => child.wait("ready")));
      workers.forEach((child) => child.start()); // Shared start barrier, not sequential opens.
      const results = await Promise.all(workers.map((child) => child.wait("done")));
      for (const result of results) {
        assert.equal(result.error, undefined);
        assert.equal(result.called, true);
        assert.equal(result.version, CATALOG_SCHEMA_VERSION);
        assert.equal(result.epoch, version === undefined ? 0 : 43);
      }
      await SqliteCatalog.use(root, async (catalog) => {
        assert.equal(catalog.epoch(), version === undefined ? 0 : 43);
        assert.equal(catalog.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='revisions_immutable_insert'").get()?.n, 1);
      });
    } finally { await Promise.all(workers.map((child) => child.close())); }
  });
});

test("schema gate waits for a real competing writer and reads its committed epoch", { timeout: 20_000 }, async () => {
  for (const version of [0, 1]) await isolated(version, async (root) => {
    const holder = new DatabaseSync(join(root, "catalog.sqlite"));
    const child = worker(root);
    try {
      await child.wait("ready");
      holder.exec("BEGIN IMMEDIATE; UPDATE metadata SET value=44 WHERE key='epoch'");
      child.start();
      await child.wait("entering");
      await delay(200);
      assert.equal(child.has("done"), false, "opener must not bypass the held writer lock");
      assert.equal(holder.prepare("PRAGMA user_version").get()?.user_version, version);
      holder.exec("COMMIT");
      const result = await child.wait("done");
      assert.equal(result.error, undefined);
      assert.equal(result.called, true);
      assert.equal(result.epoch, 44);
      assert.equal(result.version, CATALOG_SCHEMA_VERSION);
    } finally {
      await child.close();
      holder.close();
    }
  });
});

test("held writer beyond busy timeout refuses without callback or partial migration, then retries", { timeout: 20_000 }, async () => {
  await isolated(1, async (root) => {
    const path = join(root, "catalog.sqlite");
    const before = await readFile(path);
    const holder = new DatabaseSync(path);
    const child = worker(root);
    try {
      await child.wait("ready");
      holder.exec("BEGIN IMMEDIATE");
      child.start();
      await child.wait("entering");
      const result = await child.wait("done");
      assert.match(result.error ?? "", /locked|busy/i);
      assert.equal(result.called, false);
      assert.equal(holder.prepare("PRAGMA user_version").get()?.user_version, 1);
      holder.exec("ROLLBACK");
      assert.deepEqual(await readFile(path), before);
      await SqliteCatalog.use(root, async (catalog) => {
        assert.equal(catalog.epoch(), 43);
        assert.equal(catalog.db.prepare("PRAGMA user_version").get()?.user_version, CATALOG_SCHEMA_VERSION);
      });
    } finally {
      await child.close();
      holder.close();
    }
  });
});

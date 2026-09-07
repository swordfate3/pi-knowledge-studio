import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqliteCatalog } from "../src/adapters/storage/sqlite-catalog.ts";
import { ensureCatalogSchema, CATALOG_SCHEMA_VERSION } from "../src/adapters/storage/catalog-schema.ts";

// Frozen pre-versioning DDL, independent of the implementation's initializer.
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
async function withRoot(operation: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "catalog-schema-"));
  try { await operation(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
async function fixture(root: string, sql: string) {
  const path = join(root, "catalog.sqlite");
  const db = new DatabaseSync(path);
  try { db.exec(sql); } finally { db.close(); }
  await chmod(path, 0o600);
}
async function refused(root: string, pattern: RegExp) {
  const before = await readFile(join(root, "catalog.sqlite"));
  let called = false;
  await assert.rejects(SqliteCatalog.use(root, async () => { called = true; }), pattern);
  assert.equal(called, false);
  assert.deepEqual(await readFile(join(root, "catalog.sqlite")), before);
}
function dump(db: DatabaseSync) {
  return ["revisions", "active", "metadata", "hints", "vectors"].map(
    (table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  );
}
test("fresh initialization sets version atomically and reopen preserves epoch", async () => {
  await withRoot(async (root) => {
    await SqliteCatalog.use(root, async (catalog) => {
      assert.equal(catalog.db.prepare("PRAGMA user_version").get()?.user_version, CATALOG_SCHEMA_VERSION);
      assert.equal(catalog.epoch(), 0);
      catalog.db.exec("UPDATE metadata SET value=17 WHERE key='epoch'");
    });
    await SqliteCatalog.use(root, async (catalog) => assert.equal(catalog.epoch(), 17));
  });
});

test("legacy and v1 upgrades preserve every raw field, inactive history, epoch, hints and vectors", async () => {
  for (const version of [0, 1]) await withRoot(async (root) => {
    await fixture(root, legacy + `
      PRAGMA user_version=${version};
      INSERT INTO revisions VALUES ('doc','old','{"original":"原图","unknown":true}'),('doc','new','{"rendition":{"blobHash":"untouched"}}');
      INSERT INTO active VALUES ('doc','new');
      INSERT INTO hints VALUES ('hint','doc','old','{"description":"保留","authority":"retrieval-only"}');
      INSERT INTO vectors VALUES ('doc','old','space','e','[0.123,1]');
      UPDATE metadata SET value=43 WHERE key='epoch';
      INSERT INTO metadata VALUES ('additional',99);
    `);
    const db = new DatabaseSync(join(root, "catalog.sqlite"));
    const before = dump(db);
    db.close();
    await SqliteCatalog.use(root, async (catalog) => {
      assert.deepEqual(dump(catalog.db), before);
      assert.equal(catalog.epoch(), 43);
      assert.equal(catalog.db.prepare("PRAGMA user_version").get()?.user_version, CATALOG_SCHEMA_VERSION);
      assert.throws(() => catalog.db.exec("DELETE FROM revisions"), /Immutable revision/);
      assert.throws(() => catalog.db.exec("UPDATE hints SET payload=payload"), /Immutable hint/);
    });
    await SqliteCatalog.use(root, async (catalog) => {
      const separate = new DatabaseSync(join(root, "catalog.sqlite"));
      try {
        for (const connection of [catalog.db, separate]) {
          connection.exec("PRAGMA recursive_triggers=OFF");
          assert.throws(() => connection.exec("INSERT OR REPLACE INTO revisions VALUES ('doc','old','changed')"), /Immutable revision: replacement forbidden/);
          assert.deepEqual(dump(connection), before);
        }
      } finally { separate.close(); }
    });
  });
});

test("future and unknown versions/layouts refuse before callback without byte changes", async () => {
  for (const sql of [legacy + "PRAGMA user_version=999", "PRAGMA user_version=999", "CREATE TABLE unrelated(x)", "CREATE TABLE revisions(document_id TEXT)", legacy + "CREATE TABLE unexpected(x)"])
    await withRoot(async (root) => {
      await fixture(root, sql);
      await refused(root, /catalog schema/);
    });
});

test("missing or invalid epoch never resets, unversioned or current", async () => {
  for (const version of [0, 1, CATALOG_SCHEMA_VERSION])
    for (const change of ["DELETE FROM metadata WHERE key='epoch'", "UPDATE metadata SET value=-1", "UPDATE metadata SET value='broken'", "UPDATE metadata SET value=1.5"])
      await withRoot(async (root) => {
        if (version === CATALOG_SCHEMA_VERSION)
          await SqliteCatalog.use(root, async (catalog) => { catalog.db.exec(change); });
        else
          await fixture(root, legacy + `PRAGMA user_version=${version}; ${change}`);
        await refused(root, /Invalid catalog epoch/);
      });
});

test("damaged required structures and trigger semantics fail closed, including legacy", async () => {
  const variants = [
    legacy.replace("payload TEXT NOT NULL", "payload BLOB NOT NULL"),
    legacy.replace("PRIMARY KEY(document_id,revision));", "PRIMARY KEY(revision,document_id));"),
    legacy.replace("REFERENCES revisions(document_id,revision)", "REFERENCES revisions(revision,document_id)"),
    legacy.replace("revision TEXT NOT NULL", "revision TEXT"),
    legacy + "DROP TABLE vectors;",
    legacy + "DROP TRIGGER hints_immutable_insert;",
    legacy.replace("BEFORE UPDATE ON revisions BEGIN", "BEFORE UPDATE ON revisions WHEN 0 BEGIN"),
    legacy.replace("WHERE id=NEW.id", "WHERE id=OLD.id"),
    legacy.replace("RAISE(ABORT, 'Immutable revision: DELETE forbidden')", "RAISE(IGNORE)"),
    legacy + "ALTER TABLE vectors ADD COLUMN unexpected TEXT;",
  ];
  for (const version of [0, 1])
    for (const sql of variants)
      await withRoot(async (root) => {
        await fixture(root, sql + `PRAGMA user_version=${version}`);
        await refused(root, /Invalid catalog schema/);
      });
});

test("formatting, keyword case and quoted identifiers do not require exact SQLite SQL serialization", async () => {
  await withRoot(async (root) => {
    await fixture(root, legacy.replaceAll(" TEXT ", " text ").replaceAll("document_id", '"document_id"').replaceAll(",", ",\n  "));
    await SqliteCatalog.use(root, async (catalog) => assert.equal(catalog.epoch(), 0));
  });
});

test("initializer and legacy version-write faults roll back schema, data and version", () => {
  for (const version of [-1, 0, 1]) {
    const populated = version !== -1;
    for (const phase of ["after-ddl", "after-version"]) {
      const db = new DatabaseSync(":memory:");
      try {
        if (populated) db.exec(legacy + `PRAGMA user_version=${version}; UPDATE metadata SET value=23`);
        const schema = db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
        const data = populated ? dump(db) : undefined;
        const exec = db.exec.bind(db);
        db.exec = (sql: string) => {
          exec(sql);
          if ((phase === "after-ddl" && (sql.startsWith("CREATE TABLE") || sql.startsWith("CREATE TRIGGER revisions_immutable_insert"))) ||
              (phase === "after-version" && sql === `PRAGMA user_version=${CATALOG_SCHEMA_VERSION}`))
            throw new Error("injected schema fault");
        };
        assert.throws(() => ensureCatalogSchema(db), /injected schema fault/);
        db.exec = exec;
        assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, populated ? version : 0);
        assert.deepEqual(db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all(), schema);
        if (populated) assert.deepEqual(dump(db), data);
        ensureCatalogSchema(db);
        assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, CATALOG_SCHEMA_VERSION);
      } finally { db.close(); }
    }
  }
});

test("opener never invokes callback on initialization or migration fault and permits retry", async () => {
  for (const version of [-1, 0, 1]) {
    const populated = version !== -1;
    await withRoot(async (root) => {
      await fixture(root, populated ? legacy + `PRAGMA user_version=${version}; UPDATE metadata SET value=29` : "");
      const original = DatabaseSync.prototype.exec;
      let called = false;
      DatabaseSync.prototype.exec = function (sql: string) {
        original.call(this, sql);
        if (sql === `PRAGMA user_version=${CATALOG_SCHEMA_VERSION}`) throw new Error("injected opener fault");
      };
      try {
        await assert.rejects(SqliteCatalog.use(root, async () => { called = true; }), /injected opener fault/);
        assert.equal(called, false);
      } finally {
        DatabaseSync.prototype.exec = original;
      }
      const db = new DatabaseSync(join(root, "catalog.sqlite"));
      try {
        assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, populated ? version : 0);
        if (populated) assert.equal(db.prepare("SELECT value FROM metadata WHERE key='epoch'").get()?.value, 29);
        else assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema").get()?.n, 0);
      } finally { db.close(); }
      await SqliteCatalog.use(root, async (catalog) => assert.equal(catalog.epoch(), populated ? 29 : 0));
    });
  }
});

test("unknown persistent triggers refuse before writes, including epoch-freezing triggers", async () => {
  for (const version of [0, 1, CATALOG_SCHEMA_VERSION]) {
    for (const trigger of [
      "CREATE TRIGGER freeze_epoch BEFORE UPDATE ON metadata BEGIN SELECT RAISE(IGNORE); END;",
      "CREATE TRIGGER extra_audit AFTER INSERT ON active BEGIN SELECT 1; END;",
    ]) await withRoot(async (root) => {
      if (version === CATALOG_SCHEMA_VERSION) {
        await SqliteCatalog.use(root, async (catalog) => { catalog.db.exec(trigger); });
      } else {
        await fixture(root, legacy + `PRAGMA user_version=${version};` + trigger);
      }
      await refused(root, /Unknown catalog schema object/);
    });
  }
});

test("v2 missing its insert guard and corrupt legacy integrity are not repaired", async () => {
  for (const sql of [
    legacy + `PRAGMA user_version=${CATALOG_SCHEMA_VERSION}`,
    legacy + "PRAGMA foreign_keys=OFF; INSERT INTO active VALUES ('missing','revision')",
  ]) await withRoot(async (root) => {
    await fixture(root, sql);
    await refused(root, /Invalid catalog (schema|integrity)/);
  });
});

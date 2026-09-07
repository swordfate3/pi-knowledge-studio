import { DatabaseSync } from "node:sqlite";

export const CATALOG_SCHEMA_VERSION = 2;

const revisionInsertGuard = "CREATE TRIGGER revisions_immutable_insert BEFORE INSERT ON revisions WHEN EXISTS (SELECT 1 FROM revisions WHERE document_id=NEW.document_id AND revision=NEW.revision) BEGIN SELECT RAISE(ABORT, 'Immutable revision: replacement forbidden'); END;";

// Version 0 (complete legacy) and version 1 share this exact layout.
const legacyDefinitions = [
  "CREATE TABLE revisions (document_id TEXT NOT NULL, revision TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(document_id,revision));",
  "CREATE TRIGGER revisions_immutable_update BEFORE UPDATE ON revisions BEGIN SELECT RAISE(ABORT, 'Immutable revision: UPDATE forbidden'); END;",
  "CREATE TRIGGER revisions_immutable_delete BEFORE DELETE ON revisions BEGIN SELECT RAISE(ABORT, 'Immutable revision: DELETE forbidden'); END;",
  "CREATE TABLE active (document_id TEXT PRIMARY KEY, revision TEXT NOT NULL, FOREIGN KEY(document_id,revision) REFERENCES revisions(document_id,revision));",
  "CREATE TABLE metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL);",
  "CREATE TABLE hints (id TEXT PRIMARY KEY NOT NULL, document_id TEXT NOT NULL, revision TEXT NOT NULL, payload TEXT NOT NULL, FOREIGN KEY(document_id,revision) REFERENCES revisions(document_id,revision));",
  "CREATE TRIGGER hints_immutable_insert BEFORE INSERT ON hints WHEN EXISTS (SELECT 1 FROM hints WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT, 'Immutable hint: replacement forbidden'); END;",
  "CREATE TRIGGER hints_immutable_update BEFORE UPDATE ON hints BEGIN SELECT RAISE(ABORT, 'Immutable hint: UPDATE forbidden'); END;",
  "CREATE TRIGGER hints_immutable_delete BEFORE DELETE ON hints BEGIN SELECT RAISE(ABORT, 'Immutable hint: DELETE forbidden'); END;",
  "CREATE TABLE vectors (document_id TEXT NOT NULL, revision TEXT NOT NULL, space TEXT NOT NULL, element_id TEXT NOT NULL, vector TEXT NOT NULL, PRIMARY KEY(document_id,revision,space,element_id), FOREIGN KEY(document_id,revision) REFERENCES revisions(document_id,revision));",
];

const definitions = [...legacyDefinitions, revisionInsertGuard];

/** Compare tokens, not SQLite's serialized SQL formatting. Only the known DDL
 * grammar is admitted: no extra constraints, clauses, trigger conditions or
 * statements. String literals remain case-sensitive (including RAISE messages).
 * Unusual but equivalent SQL is deliberately refused rather than guessed safe. */
function tokens(sql: string): string {
  const parts = sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*|\d+|[^\s]/g) ?? [];
  if (parts.at(-1) === ";") parts.pop();
  return JSON.stringify(parts.map((part) => {
    if (part.startsWith("'")) return part;
    if (part.startsWith('"')) return part.slice(1, -1).replaceAll('""', '"').toLowerCase();
    if (part.startsWith("`") || part.startsWith("[")) return part.slice(1, -1).toLowerCase();
    return part.toLowerCase();
  }));
}

function objects(db: DatabaseSync) {
  return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all();
}

/** Read-only validation, using SQLite's own structural interpretation as well
 * as a conservative token allowlist for semantics PRAGMAs do not expose.
 * Does not check version, row integrity or caller-specific budgets, or write to db.
 * Production migration retains those checks in validate/ensureCatalogSchema. */
export function validateCatalogStructure(db: DatabaseSync, ddl: readonly string[] = definitions): void {
  const reference = new DatabaseSync(":memory:");
  try {
    reference.exec(ddl.join("\n"));
    const expected = objects(reference);
    const actual = objects(db);
    for (const object of expected) {
      const found = actual.find((item) => item.name === object.name);
      if (!found || found.type !== object.type || found.tbl_name !== object.tbl_name ||
          typeof found.sql !== "string" || typeof object.sql !== "string" ||
          tokens(found.sql) !== tokens(object.sql))
        throw new Error(`Invalid catalog schema: ${object.name}`);
      if (object.type !== "table") continue;
      // Names originate only from the fixed reference schema, never input SQL.
      for (const pragma of ["table_xinfo", "foreign_key_list", "index_list"]) {
        const query = `PRAGMA ${pragma}('${object.name}')`;
        if (JSON.stringify(db.prepare(query).all()) !== JSON.stringify(reference.prepare(query).all()))
          throw new Error(`Invalid catalog schema: ${object.name} ${pragma}`);
      }
    }
    for (const object of actual) {
      if (expected.some((item) => item.name === object.name)) continue;
      // Additional persistent triggers can suppress writes (RAISE(IGNORE)),
      // including epoch advancement. No unvalidated persistent objects are safe.
      throw new Error(`Unknown catalog schema object: ${object.name}`);
    }
  } finally {
    reference.close();
  }
}

function validate(db: DatabaseSync, ddl: readonly string[] = definitions): void {
  validateCatalogStructure(db, ddl);
  const epoch = db.prepare("SELECT value FROM metadata WHERE key='epoch'").get()?.value;
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0)
    throw new Error("Invalid catalog epoch");
  if (db.prepare("PRAGMA foreign_key_check").all().length ||
      db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
    throw new Error("Invalid catalog integrity");
}

/** Version 0 supports only an empty DB or the complete pre-versioning layout;
 * version 1 must match that same layout. Upgrade to v2 adds only an INSERT guard,
 * retaining all rows verbatim. Validate the old layout before any persistent write.
 * No partial-schema repair, epoch reset, or older-layout inference is permitted.
 * The writer reservation keeps validation, DDL and version advancement atomic. */
export function ensureCatalogSchema(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 0 && version !== 1 && version !== CATALOG_SCHEMA_VERSION)
      throw new Error(`Unsupported catalog schema version: ${version}`);
    const empty = objects(db).length === 0 &&
      db.prepare("SELECT count(*) AS n FROM sqlite_schema").get()?.n === 0;
    if (version === 0 && empty) {
      db.exec(definitions.join("\n"));
      db.exec("INSERT INTO metadata VALUES ('epoch',0)");
      validate(db);
    } else if (version === 0 || version === 1) {
      validate(db, legacyDefinitions);
      db.exec(revisionInsertGuard);
      validate(db);
    } else {
      validate(db);
    }
    if (version !== CATALOG_SCHEMA_VERSION)
      db.exec(`PRAGMA user_version=${CATALOG_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

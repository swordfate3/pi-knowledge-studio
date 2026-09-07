import { ensureCatalogSchema } from "./catalog-schema.ts";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { constants } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";
import {
  ensureDirectorySafe,
  withSafeDirectory,
} from "../../core/path-safety.ts";
import { sha256 } from "../blob/file-blob-store.ts";
import { validateCapture } from "../../application/validate-capture.ts";
import { validateVisionHint } from "../../application/vision-hints.ts";
import type { VisionHint } from "../../domain/vision-enrichment.ts";
import type {
  CapturedDocument,
  EmbeddingSpace,
} from "../../domain/retrieval.ts";

function parseCapture(value: string): CapturedDocument {
  try {
    const document = JSON.parse(value) as CapturedDocument;
    validateCapture(document);
    return document;
  } catch {
    throw new Error("Invalid catalog capture");
  }
}

function parseVector(value: string): number[] {
  try {
    const vector = JSON.parse(value) as number[];
    if (
      !Array.isArray(vector) ||
      vector.length < 1 ||
      vector.length > 8192 ||
      vector.some((item) => typeof item !== "number" || !Number.isFinite(item))
    )
      throw new Error("Invalid vector");
    return vector;
  } catch {
    throw new Error("Invalid catalog vector");
  }
}

export function spaceKey(space: EmbeddingSpace): string {
  return sha256(
    JSON.stringify([
      space.provider,
      space.model,
      space.revision,
      space.dimension,
      space.queryInstruction,
      space.documentInstruction,
      "cosine",
      "text-v1",
    ]),
  );
}

/** Local single-user catalog. No network/model calls inside synchronous transactions. */
export class SqliteCatalog {
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  static async use<T>(
    root: string,
    operation: (catalog: SqliteCatalog) => Promise<T>,
  ): Promise<T> {
    await ensureDirectorySafe(root);
    return withSafeDirectory(root, root, async (directory) => {
      const info = await stat(directory);
      if (
        process.platform !== "win32" &&
        ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
      )
        throw new Error("Catalog requires a private owned directory");
      for (const name of [
        "catalog.sqlite",
        "catalog.sqlite-wal",
        "catalog.sqlite-shm",
        "catalog.sqlite-journal",
      ]) {
        try {
          const file = await lstat(join(directory, name));
          if (
            !file.isFile() ||
            file.isSymbolicLink() ||
            (process.platform !== "win32" &&
              ((file.mode & 0o077) !== 0 || file.uid !== process.getuid?.()))
          )
            throw new Error("Unsafe catalog file");
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "ENOENT"
          )
            throw error;
        }
      }
      const databasePath = join(directory, "catalog.sqlite");
      // Exclusive creation never truncates or chmods an existing catalog. SQLite
      // derives journal/WAL/SHM permissions from the database's private mode.
      try {
        const file = await open(
          databasePath,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        try {
          await file.chmod(0o600);
        } finally {
          await file.close();
        }
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "EEXIST"
        )
          throw error;
      }
      const databaseInfo = await lstat(databasePath);
      if (
        !databaseInfo.isFile() ||
        databaseInfo.isSymbolicLink() ||
        (process.platform !== "win32" &&
          ((databaseInfo.mode & 0o077) !== 0 ||
            databaseInfo.uid !== process.getuid?.()))
      )
        throw new Error("Unsafe catalog file");
      const db = new DatabaseSync(databasePath);
      try {
        db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
        ensureCatalogSchema(db);
        return await operation(new SqliteCatalog(db));
      } finally {
        db.close();
      }
    });
  }

  epoch(): number {
    const epoch = this.db
      .prepare("SELECT value FROM metadata WHERE key='epoch'")
      .get()?.value;
    if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0)
      throw new Error("Invalid catalog epoch");
    return epoch;
  }

  /** One SQLite read snapshot, including only active revisions and the requested space. */
  snapshot(space?: EmbeddingSpace): {
    epoch: number;
    documents: CapturedDocument[];
    vectors: Map<string, Map<string, number[]>>;
    hints: VisionHint[];
  } {
    this.db.exec("BEGIN");
    try {
      const epoch = this.epoch();
      const documents = this.documents();
      const vectors = new Map<string, Map<string, number[]>>();
      if (space)
        for (const document of documents)
          vectors.set(document.id, this.vectors(document, space));
      const hints = this.db
        .prepare(
          "SELECT h.id,h.document_id,h.revision,h.payload FROM hints h JOIN active a ON a.document_id=h.document_id AND a.revision=h.revision ORDER BY h.id",
        )
        .all()
        .map((row) => {
          const document = documents.find(
            (item) =>
              item.id === row.document_id && item.revision === row.revision,
          );
          if (!document) throw new Error("Stored hint binding mismatch");
          return this.parseHint(row, document);
        });
      this.db.exec("COMMIT");
      // Hints are explicit snapshot data; evidence builders must project source fields.
      return { epoch, documents, vectors, hints };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private parseHint(
    row: {
      id?: unknown;
      document_id?: unknown;
      revision?: unknown;
      payload?: unknown;
    },
    document: CapturedDocument,
  ): VisionHint {
    if (typeof row.payload !== "string" || row.payload.length > 120_000)
      throw new Error("Invalid stored hint");
    try {
      const hint: unknown = JSON.parse(row.payload);
      validateVisionHint(hint, document);
      if (
        hint.id !== row.id ||
        hint.documentId !== row.document_id ||
        hint.revision !== row.revision
      )
        throw new Error("Stored hint identity mismatch");
      return Object.freeze(hint);
    } catch (error) {
      throw new Error("Invalid stored hint payload or identity", {
        cause: error,
      });
    }
  }

  saveHint(record: VisionHint, expectedEpoch: number): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.epoch() !== expectedEpoch)
        throw new Error(
          "Catalog changed during vision enrichment; retry explicitly",
        );
      const document = this.documents().find(
        (item) =>
          item.id === record.documentId && item.revision === record.revision,
      );
      if (!document) throw new Error("Source is no longer active");
      validateVisionHint(record, document);
      const old = this.db
        .prepare("SELECT id,document_id,revision,payload FROM hints WHERE id=?")
        .get(record.id);
      if (old) {
        const stored = this.parseHint(old, document);
        if (
          stored.description !== record.description ||
          stored.descriptionHash !== record.descriptionHash
        )
          throw new Error("Immutable vision hint conflict");
      } else {
        this.db
          .prepare("INSERT INTO hints VALUES (?,?,?,?)")
          .run(
            record.id,
            record.documentId,
            record.revision,
            JSON.stringify(record),
          );
        this.db.exec("UPDATE metadata SET value=value+1 WHERE key='epoch'");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  publish(document: CapturedDocument, expectedEpoch: number): void {
    validateCapture(document);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.epoch() !== expectedEpoch)
        throw new Error("Catalog changed during import; retry explicitly");
      const payload = JSON.stringify(document);
      const old = this.db
        .prepare(
          "SELECT payload FROM revisions WHERE document_id=? AND revision=?",
        )
        .get(document.id, document.revision);
      if (old && old.payload !== payload)
        throw new Error("Immutable revision collision");
      // Duplicate INSERTs are forbidden by the schema, even with OR IGNORE or
      // OR REPLACE. An identical retained revision needs only reactivation.
      if (!old)
        this.db
          .prepare("INSERT INTO revisions VALUES (?,?,?)")
          .run(document.id, document.revision, payload);
      this.db
        .prepare(
          "INSERT INTO active VALUES (?,?) ON CONFLICT(document_id) DO UPDATE SET revision=excluded.revision",
        )
        .run(document.id, document.revision);
      this.db.exec(
        "UPDATE metadata SET value=value+1 WHERE key='epoch'; COMMIT",
      );
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  documents(): CapturedDocument[] {
    return this.db
      .prepare(
        "SELECT r.document_id,r.revision,r.payload FROM revisions r JOIN active a ON a.document_id=r.document_id AND a.revision=r.revision ORDER BY r.document_id",
      )
      .all()
      .map((row) => {
        if (typeof row.payload !== "string" || row.payload.length > 8_000_000)
          throw new Error("Invalid stored capture");
        const document = parseCapture(row.payload);
        validateCapture(document);
        if (
          document.id !== row.document_id ||
          document.revision !== row.revision
        )
          throw new Error("Stored capture identity mismatch");
        return document;
      });
  }

  remove(documentId: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const removed = this.db
        .prepare("DELETE FROM active WHERE document_id=?")
        .run(documentId).changes;
      this.db.exec(
        "UPDATE metadata SET value=value+1 WHERE key='epoch'; COMMIT",
      );
      return Number(removed) > 0;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  saveVectors(
    document: CapturedDocument,
    space: EmbeddingSpace,
    vectors: number[][],
    expectedEpoch: number,
  ): void {
    if (vectors.length !== document.elements.length)
      throw new Error("Embedding count mismatch");
    for (const vector of vectors) {
      if (
        vector.length !== space.dimension ||
        vector.some((value) => !Number.isFinite(value)) ||
        !vector.some((value) => value !== 0)
      )
        throw new Error("Invalid embedding vector");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.epoch() !== expectedEpoch)
        throw new Error("Catalog changed during embedding; retry explicitly");
      const active = this.db
        .prepare("SELECT revision FROM active WHERE document_id=?")
        .get(document.id);
      if (active?.revision !== document.revision)
        throw new Error("Source is no longer active");
      const insert = this.db.prepare(
        "INSERT OR REPLACE INTO vectors VALUES (?,?,?,?,?)",
      );
      document.elements.forEach((element, index) =>
        insert.run(
          document.id,
          document.revision,
          spaceKey(space),
          element.id,
          JSON.stringify(vectors[index]),
        ),
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  vectors(
    document: CapturedDocument,
    space: EmbeddingSpace,
  ): Map<string, number[]> {
    if (
      !Number.isSafeInteger(space.dimension) ||
      space.dimension < 1 ||
      space.dimension > 8192
    )
      throw new Error("Invalid embedding dimension");
    const elementIds = new Set(document.elements.map((element) => element.id));
    return new Map(
      this.db
        .prepare(
          "SELECT element_id,vector FROM vectors WHERE document_id=? AND revision=? AND space=?",
        )
        .all(document.id, document.revision, spaceKey(space))
        .map((row) => {
          if (
            typeof row.element_id !== "string" ||
            !elementIds.has(row.element_id) ||
            typeof row.vector !== "string" ||
            row.vector.length > 1_000_000
          )
            throw new Error("Invalid catalog vector record");
          const vector = parseVector(row.vector);
          if (
            vector.length !== space.dimension ||
            !vector.some((value) => value !== 0)
          )
            throw new Error("Invalid catalog vector dimension or norm");
          return [row.element_id, vector];
        }),
    );
  }
}

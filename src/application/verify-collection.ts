import { DatabaseSync } from "node:sqlite";
import { constants } from "node:fs";
import { lstat, open, opendir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { validateCatalogStructure, CATALOG_SCHEMA_VERSION } from "../adapters/storage/catalog-schema.ts";
import { sha256 } from "../adapters/blob/file-blob-store.ts";
import { withSafeDirectory } from "../core/path-safety.ts";
import { validateCapture } from "./validate-capture.ts";
import { validateVisionHint } from "./vision-hints.ts";
import { verifyOcrRender } from "./verify-ocr-artifacts.ts";
import { verifyOcrText } from "../domain/ocr.ts";
import { verifiedDisplay } from "../adapters/parsing/capture-image.ts";
import type { CapturedDocument } from "../domain/retrieval.ts";
import type { BlobStore } from "../ports/blob-store.ts";

export const VERIFICATION_LIMITS = Object.freeze({
  databaseBytes: 256 * 1024 * 1024,
  rows: 10_000,
  payloadBytes: 32 * 1024 * 1024,
  blobBytes: 20 * 1024 * 1024,
  totalBlobBytes: 512 * 1024 * 1024,
  captureItems: 20_000,
  artifacts: 20_000,
  issues: 100,
});
class VerificationBudgetExhausted extends Error {}
const BUDGET_EXHAUSTED = "verification-budget-exhausted";

export interface CollectionVerification {
  status: "passed" | "incomplete" | "failed";
  scope: "offline-retained-integrity";
  counts: { revisions: number; active: number; inactive: number; hints: number; vectors: number; blobs: number; orphanBlobs: number; staging: number; otherArtifacts: number };
  issues: { code: string; count: number }[];
  unsupported: string[];
  limitations: string[];
}

/** Host-only offline audit. No initialization, chmod, repair, model/network calls or GC.
 * Fail-fast safety/budget errors deliberately return only fixed codes, never payloads/paths.
 * Quiescence is an operator prerequisite, not something this read transaction proves.
 */
export async function verifyCollection(root: string, options: { offline: boolean }): Promise<CollectionVerification> {
  const report: CollectionVerification = {
    status: "passed", scope: "offline-retained-integrity",
    counts: { revisions: 0, active: 0, inactive: 0, hints: 0, vectors: 0, blobs: 0, orphanBlobs: 0, staging: 0, otherArtifacts: 0 },
    issues: [], unsupported: [],
    limitations: [
      "Requires all writers stopped and a checkpointed rollback-mode copy; not a live coherent backup guarantee.",
      "Hashes establish retained-byte consistency, not same-user tamper authenticity or power-loss durability.",
      "Source parsing/extraction, OCR recognition and model output correctness are not reproduced or certified.",
      "No external manifest binds original extraction to source bytes; stored capture/provenance bindings only.",
      "Counts describe completed work before any fail-fast error; informational artifacts are never repaired or deleted.",
      "Blob budget is cumulative requested read bytes, including repeat hashes; exhaustion stops verification, not proof of corruption.",
      "Read access may update filesystem atime; no content, permissions or schema writes are performed.",
    ],
  };
  let phase = "unsafe-root";
  let issueCount = 0;
  const issue = (code: string) => {
    report.status = "failed";
    const old = report.issues.find(item => item.code === code);
    if (old) old.count++; else report.issues.push({ code, count: 1 });
    if (++issueCount >= VERIFICATION_LIMITS.issues) throw new VerificationBudgetExhausted();
  };
  const check = async (code: string, fn: () => Promise<unknown>) => {
    try { await fn(); } catch (error) {
      if (error instanceof VerificationBudgetExhausted) throw error;
      issue(code);
    }
  };
  const privateInfo = (info: Awaited<ReturnType<typeof stat>>, directory: boolean) => {
    if ((directory ? !info.isDirectory() : !info.isFile()) || info.isSymbolicLink() ||
        info.uid !== process.getuid?.() || (Number(info.mode) & 0o077) !== 0 || (!directory && info.nlink !== 1))
      throw new Error("Unsafe ownership/type/mode");
  };
  const read = async (path: string, max: number) => {
    const info = await lstat(path);
    privateInfo(info, false);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const actual = await handle.stat();
      privateInfo(actual, false);
      if (actual.ino !== info.ino || actual.dev !== info.dev) throw new Error("Unsafe file/size");
      if (actual.size > max) throw new VerificationBudgetExhausted();
      const bytes = Buffer.alloc(actual.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw new Error("Short read");
        offset += bytesRead;
      }
      return bytes;
    } finally { await handle.close(); }
  };
  try {
    if (options?.offline !== true) { phase = "offline-confirmation-required"; throw new Error("Offline required"); }
    // Other platforms lack this implementation's descriptor-relative/private-owner guarantees.
    if (process.platform !== "linux") { phase = "unsupported-platform"; throw new Error("Linux required"); }
    if (typeof root !== "string" || !isAbsolute(root) || root.includes("\0") || root.split("/").includes("..")) throw new Error("Unsafe root");
    await withSafeDirectory(root, root, async directory => {
      privateInfo(await stat(directory), true);
      phase = "unsafe-catalog";
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        try { await lstat(join(directory, `catalog.sqlite${suffix}`)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        phase = "sidecar-present-offline-copy-required";
        throw new Error("Sidecar present");
      }
      const dbPath = join(directory, "catalog.sqlite");
      // Read bounded bytes before SQLite gets the path. WAL-mode headers are refused even without sidecars.
      const header = await read(dbPath, VERIFICATION_LIMITS.databaseBytes);
      if (header.length < 100 || header.toString("ascii", 0, 16) !== "SQLite format 3\0" || header[18] !== 1 || header[19] !== 1)
        throw new Error("Unsupported database header");
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN");
        phase = "unsupported-schema";
        if (db.prepare("PRAGMA user_version").get()?.user_version !== CATALOG_SCHEMA_VERSION) throw new Error("Unsupported schema");
        const schemaBudget = db.prepare("SELECT count(*) AS n, coalesce(sum(length(CAST(sql AS BLOB)) + length(CAST(name AS BLOB)) + length(CAST(tbl_name AS BLOB))),0) AS bytes FROM sqlite_schema").get()!;
        if (typeof schemaBudget.n !== "number" || schemaBudget.n > 100 || typeof schemaBudget.bytes !== "number" || schemaBudget.bytes > 100_000)
          throw new VerificationBudgetExhausted();
        phase = "catalog-budget-or-integrity";
        let rows = 0;
        for (const table of ["revisions", "active", "hints", "vectors", "metadata"]) {
          rows += Number(db.prepare(`SELECT count(*) AS n FROM (SELECT 1 FROM ${table} LIMIT 10001)`).get()!.n);
          if (rows > VERIFICATION_LIMITS.rows) throw new VerificationBudgetExhausted();
        }
        phase = "unsupported-schema";
        validateCatalogStructure(db);
        phase = "catalog-budget-or-integrity";
        const epoch = db.prepare("SELECT value FROM metadata WHERE key='epoch'").get()?.value;
        if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0 || db.prepare("SELECT count(*) AS n FROM metadata").get()?.n !== 1) throw new Error("Metadata");
        if (db.prepare("PRAGMA quick_check(1)").get()?.quick_check !== "ok" || db.prepare("PRAGMA foreign_key_check").get()) throw new Error("Integrity");
        // Bound identifiers before fetching records (SQLite TEXT affinity alone is not validation).
        for (const [table, columns] of [
          ["revisions", ["document_id", "revision"]], ["active", ["document_id", "revision"]],
          ["hints", ["id", "document_id", "revision"]], ["vectors", ["document_id", "revision", "space", "element_id"]],
        ] as const) for (const column of columns) {
          if (db.prepare(`SELECT 1 FROM ${table} WHERE typeof(${column}) != 'text' LIMIT 1`).get())
            throw new Error("Identifier type");
          if (db.prepare(`SELECT 1 FROM ${table} WHERE length(CAST(${column} AS BLOB)) > 128 LIMIT 1`).get())
            throw new VerificationBudgetExhausted();
        }
        let payloadBytes = 0;
        for (const [table, column, max] of [["revisions", "payload", 8_000_000], ["hints", "payload", 120_000], ["vectors", "vector", 1_000_000]] as const) {
          for (const row of db.prepare(`SELECT typeof(${column}) AS t,length(CAST(${column} AS BLOB)) AS n FROM ${table}`).iterate()) {
            if (row.t !== "text" || typeof row.n !== "number") throw new Error("Payload type");
            if (row.n > max) throw new VerificationBudgetExhausted();
            payloadBytes += row.n;
            if (payloadBytes > VERIFICATION_LIMITS.payloadBytes) throw new VerificationBudgetExhausted();
          }
        }
        await withSafeDirectory(root, join(root, "blobs"), async blobDirectory => {
          privateInfo(await stat(blobDirectory), true);
          const referenced = new Set<string>();
          let blobBytes = 0;
          const blobs: BlobStore = {
            put: async () => { throw new Error("Read only"); },
            get: async hash => {
              if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid hash");
              referenced.add(hash);
              const info = await lstat(join(blobDirectory, hash));
              privateInfo(info, false);
              const size = info.size;
              blobBytes += size;
              if (blobBytes > VERIFICATION_LIMITS.totalBlobBytes) throw new VerificationBudgetExhausted();
              const bytes = await read(join(blobDirectory, hash), VERIFICATION_LIMITS.blobBytes);
              if (sha256(bytes) !== hash) throw new Error("Blob hash");
              return bytes;
            },
          };
          const dimensions = new Map<string, number>();
          phase = "retained-record-check";
          let captureItems = 0;
          for (const row of db.prepare("SELECT document_id,revision,payload FROM revisions").iterate()) {
            let doc: CapturedDocument;
            try {
              doc = JSON.parse(row.payload as string) as CapturedDocument;
              if (!doc || !Array.isArray(doc.elements) || !Array.isArray(doc.images)) throw new Error("Capture shape");
              captureItems += doc.elements.length + doc.images.length;
              if (captureItems > VERIFICATION_LIMITS.captureItems) throw new VerificationBudgetExhausted();
              validateCapture(doc);
              if (doc.id !== row.document_id || doc.revision !== row.revision) throw new Error("Binding");
            } catch (error) {
              if (error instanceof VerificationBudgetExhausted) throw error;
              issue("invalid-capture-or-identity"); continue;
            }
            report.counts.revisions++;
            if (db.prepare("SELECT 1 FROM active WHERE document_id=? AND revision=?").get(doc.id, doc.revision)) report.counts.active++;
            else report.counts.inactive++;
            await check("source-blob-invalid", () => blobs.get(doc.sourceHash));
            for (const image of doc.images) {
              await check("image-original-blob-invalid", () => blobs.get(image.blobHash));
              if (image.rendition) await check("rendition-blob-invalid", () => blobs.get(image.rendition!.blobHash));
              await check("image-original-or-rendition-invalid", () => verifiedDisplay(image, blobs));
              if (image.originKind === "standalone_original" && image.blobHash !== doc.sourceHash) issue("standalone-source-binding-invalid");
              if (image.provenance) {
                await check("ocr-render-invalid", () => verifyOcrRender(image.provenance!, blobs));
                await check("ocr-transcript-coverage-invalid", async () => {
                  const bytes = await blobs.get(image.provenance!.transcriptHash);
                  if (bytes.length > 400_000) throw new VerificationBudgetExhausted();
                  const transcript = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
                  const text = doc.elements.filter(e => image.elementIds.includes(e.id)).map(e => e.text).join("");
                  if (text !== transcript) throw new Error("Transcript coverage");
                });
              }
            }
            for (const element of doc.elements) if (element.provenance)
              await check("ocr-transcript-invalid", () => verifyOcrText(element.text, element.provenance!, blobs));
            for (const hintRow of db.prepare("SELECT id,payload FROM hints WHERE document_id=? AND revision=?").iterate(doc.id, doc.revision)) {
              report.counts.hints++;
              await check("hint-invalid", async () => {
                const hint: unknown = JSON.parse(hintRow.payload as string);
                validateVisionHint(hint, doc);
                if (hint.id !== hintRow.id) throw new Error("Hint identity");
              });
            }
            const ids = new Set(doc.elements.map(e => e.id));
            for (const v of db.prepare("SELECT space,element_id,vector FROM vectors WHERE document_id=? AND revision=?").iterate(doc.id, doc.revision)) {
              report.counts.vectors++;
              await check("vector-invalid", async () => {
                if (typeof v.space !== "string" || !/^[a-f0-9]{64}$/.test(v.space) || typeof v.element_id !== "string" || !ids.has(v.element_id)) throw new Error("Vector binding");
                const vector: unknown = JSON.parse(v.vector as string);
                if (!Array.isArray(vector) || vector.length < 1 || vector.length > 8192 || vector.some(x => typeof x !== "number" || !Number.isFinite(x)) || !vector.some(x => x !== 0)) throw new Error("Vector values");
                const dimension = dimensions.get(v.space);
                if (dimension !== undefined && dimension !== vector.length) throw new Error("Dimension mismatch");
                dimensions.set(v.space, vector.length);
              });
            }
          }
          if (report.counts.vectors) report.unsupported.push("Embedding space is an opaque hash: provider/model/instructions and declared dimension cannot be recovered. Checked finite nonzero vectors, 1..8192 dimensions, element/revision references and same-space dimension consistency only; completeness not inferred.");
          phase = "artifact-inventory-unsafe-or-budget";
          let artifacts = 0;
          for (const [path, isBlobs] of [[directory, false], [blobDirectory, true]] as const) {
            const entries = await opendir(path);
            for await (const entry of entries) {
              if (++artifacts > VERIFICATION_LIMITS.artifacts) throw new VerificationBudgetExhausted();
              const info = await lstat(join(path, entry.name));
              if (!isBlobs && entry.name === "blobs") { privateInfo(info, true); continue; }
              privateInfo(info, false);
              if (!isBlobs && entry.name === "catalog.sqlite") continue;
              if (isBlobs && /^[a-f0-9]{64}$/.test(entry.name)) {
                if (!referenced.has(entry.name)) report.counts.orphanBlobs++;
              } else if (entry.name.startsWith(".staging-")) report.counts.staging++;
              else report.counts.otherArtifacts++;
            }
          }
          report.counts.blobs = referenced.size;
        });
      } finally { db.close(); }
    });
  } catch (error) {
    if (error instanceof VerificationBudgetExhausted) {
      report.status = "incomplete";
      report.issues.push({ code: BUDGET_EXHAUSTED, count: 1 });
    } else if (issueCount < VERIFICATION_LIMITS.issues) issue(phase);
  }
  if (report.status === "passed" && report.unsupported.length) report.status = "incomplete";
  return report;
}

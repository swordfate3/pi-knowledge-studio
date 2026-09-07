import { constants } from "node:fs";
import { open, lstat, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { assertNoSymlinkPath, ensureDirectorySafe, withSafeDirectory } from "../core/path-safety.ts";
import { runWorker, validatePdfWindow } from "../adapters/parsing/capture-pdf.ts";
import { encodePng } from "../adapters/export/encode-png.ts";
import { cosine } from "./rank-evidence.ts";
import { chunkRetrievalText } from "../core/retrieval-chunks.ts";
import { sha256 } from "../adapters/blob/file-blob-store.ts";
import type { EmbeddingProvider, EmbeddingSpace } from "../domain/retrieval.ts";

const VERSION = "native-pdf-job-v1";
const HASH = /^[a-f0-9]{64}$/;
const BATCH = 4;
const MAX_RECORD = 8 * 1024 * 1024;
const MAX_IMAGE = 20 * 1024 * 1024;
const SCHEMA = "CREATE TABLE manifest(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL); CREATE TABLE windows(start INTEGER PRIMARY KEY,json TEXT NOT NULL,hash TEXT NOT NULL); CREATE TABLE batches(start INTEGER,offset INTEGER,json TEXT NOT NULL,binding TEXT NOT NULL,PRIMARY KEY(start,offset)); CREATE TABLE images(hash TEXT PRIMARY KEY,bytes BLOB NOT NULL)";
// Compare every schema object, including implicit indexes, before any application SQL.
const reference = new DatabaseSync(":memory:");
reference.exec(SCHEMA);
const schemaQuery = "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name";
const expectedSchema = JSON.stringify(reference.prepare(schemaQuery).all());
reference.close();
function checkSchema(db: DatabaseSync, lock = false) {
  const count = db.prepare("SELECT count(*) AS n FROM sqlite_schema").get()?.n;
  if (typeof count !== "number" || count > 6 || db.prepare("SELECT 1 FROM sqlite_schema WHERE length(CAST(sql AS BLOB))>4096 OR length(CAST(name AS BLOB))>128 OR length(CAST(tbl_name AS BLOB))>128 LIMIT 1").get()) throw new Error("Unknown PDF job database schema");
  if (JSON.stringify(db.prepare(schemaQuery).all()) !== (lock ? "[]" : expectedSchema)) throw new Error("Unknown PDF job database schema");
}
function checkPages(db: DatabaseSync, maxBytes: number) {
  const size = db.prepare("PRAGMA page_size").get()?.page_size;
  const count = db.prepare("PRAGMA page_count").get()?.page_count;
  if (size !== 4096 || typeof count !== "number" || count * size > maxBytes) throw new Error("PDF job database storage quota/page configuration exceeded");
}
export interface PdfJobLimits { maxInputBytes: number; maxStorageBytes: number }
export const DEFAULT_PDF_JOB_LIMITS: PdfJobLimits = { maxInputBytes: 512 * 1024 * 1024, maxStorageBytes: 4 * 1024 ** 3 };
export interface PdfJobManifest {
  version: typeof VERSION; bookId: string; sourceHash: string; sourceBytes: number;
  limits: PdfJobLimits; totalPages: number | null; parsedPages: number;
  indexedWindows: number; batchOffset: number; space: EmbeddingSpace | null;
  state: "parsing" | "parsed" | "indexing" | "ready";
}
interface Element { id: string; page: number; text: string }
interface Image { hash: string; page: number; elementIds: string[] }
export interface PdfWindow { start: number; end: number; elements: Element[]; images: Image[] }
type Window = PdfWindow;
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys.sort().join()) throw new Error("Invalid PDF job record");
}
function positive(n: unknown): n is number { return typeof n === "number" && Number.isSafeInteger(n) && n > 0; }
function nonnegative(n: unknown): n is number { return n === 0 || positive(n); }
function limits(value: PdfJobLimits) {
  exact(value, ["maxInputBytes", "maxStorageBytes"]);
  if (!positive(value.maxInputBytes) || !positive(value.maxStorageBytes) || value.maxStorageBytes < value.maxInputBytes + 1024 * 1024) throw new Error("Invalid PDF job quotas");
}
function space(value: EmbeddingSpace): string {
  exact(value, ["provider", "model", "revision", "dimension", "queryInstruction", "documentInstruction"]);
  for (const key of ["provider", "model", "revision", "queryInstruction", "documentInstruction"] as const)
    if (typeof value[key] !== "string" || value[key].length > 8192 || (["provider", "model", "revision"].includes(key) && !value[key].trim())) throw new Error("Invalid PDF job model identity");
  if (!positive(value.dimension) || value.dimension > 8192) throw new Error("Invalid PDF job dimension");
  return JSON.stringify([value.provider, value.model, value.revision, value.dimension, value.queryInstruction, value.documentInstruction]);
}
function validate(m: PdfJobManifest) {
  exact(m, ["version", "bookId", "sourceHash", "sourceBytes", "limits", "totalPages", "parsedPages", "indexedWindows", "batchOffset", "space", "state"]);
  limits(m.limits);
  if (m.version !== VERSION || !HASH.test(m.sourceHash) || m.bookId !== `book_${m.sourceHash}` || !positive(m.sourceBytes) || m.sourceBytes > m.limits.maxInputBytes || !nonnegative(m.parsedPages) || !nonnegative(m.indexedWindows) || !nonnegative(m.batchOffset) || m.batchOffset % BATCH !== 0 || !["parsing", "parsed", "indexing", "ready"].includes(m.state)) throw new Error("Invalid PDF job manifest");
  if (m.totalPages === null ? m.parsedPages !== 0 : !positive(m.totalPages) || m.parsedPages > m.totalPages) throw new Error("Invalid PDF job page checkpoint");
  if (m.parsedPages !== m.totalPages && m.parsedPages % 5 !== 0) throw new Error("Invalid PDF job window checkpoint");
  if (m.indexedWindows > Math.ceil(m.parsedPages / 5) || (m.space === null && (m.indexedWindows || m.batchOffset || m.state === "ready" || m.state === "indexing"))) throw new Error("Invalid PDF job embedding checkpoint");
  if (m.space !== null) space(m.space);
  if ((m.state === "parsing" || m.state === "parsed") && m.space !== null) throw new Error("Invalid PDF job phase/model binding");
  if (m.batchOffset && m.indexedWindows >= Math.ceil(m.parsedPages / 5)) throw new Error("Invalid PDF job trailing batch");
  if (m.state !== "parsing" && (m.totalPages === null || m.parsedPages !== m.totalPages)) throw new Error("Incomplete PDF job cannot be published");
  if (m.state === "ready" && (m.indexedWindows !== Math.ceil(m.parsedPages / 5) || m.batchOffset !== 0)) throw new Error("Incomplete PDF job vectors");
}
function parse<T>(raw: unknown): T {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_RECORD) throw new Error("Invalid PDF job JSON size");
  return JSON.parse(raw) as T;
}
function vectors(raw: number[][], count: number, dimension: number) {
  if (!Array.isArray(raw) || raw.length !== count || raw.some(v => !Array.isArray(v) || v.length !== dimension || v.some(x => typeof x !== "number" || !Number.isFinite(x)) || !v.some(x => x !== 0))) throw new Error("Invalid PDF job vectors");
}
function windowRecord(w: Window, start: number, m: PdfJobManifest) {
  exact(w, ["start", "end", "elements", "images"]);
  if (w.start !== start || w.end !== Math.min(start + 4, m.totalPages!) || !Array.isArray(w.elements) || w.elements.length > 5000 || !Array.isArray(w.images) || w.images.length > 100) throw new Error("Invalid PDF job window");
  for (const [i, e] of w.elements.entries()) {
    exact(e, ["id", "page", "text"]);
    if (e.id !== `p${start}_e${i}` || !positive(e.page) || e.page < start || e.page > w.end || typeof e.text !== "string" || e.text.length > 32768) throw new Error("Invalid PDF job element");
  }
  const ids = new Map(w.elements.map(e => [e.id, e.page]));
  for (const i of w.images) {
    exact(i, ["hash", "page", "elementIds"]);
    if (!HASH.test(i.hash) || !positive(i.page) || i.page < start || i.page > w.end || !Array.isArray(i.elementIds) || i.elementIds.length > 5000 || i.elementIds.some(id => ids.get(id) !== i.page)) throw new Error("Invalid PDF job image binding");
  }
}
async function privateFile(path: string, create = false) {
  let created = false;
  const file = await (async () => {
    if (create) {
      try { const f = await open(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_CREAT | constants.O_EXCL, 0o600); created = true; return f; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    }
    return open(path, constants.O_RDWR | constants.O_NOFOLLOW);
  })();
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error("PDF jobs require private owner-only regular files");
  } finally { await file.close(); }
  return created;
}
async function digest(path: string, max: number, signal?: AbortSignal, destination?: string) {
  const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const output = destination ? await open(destination, "wx", 0o600) : undefined;
  try {
    const before = await source.stat();
    if (!before.isFile() || !positive(before.size) || before.size > max) throw new Error("PDF job input quota exceeded or unsafe source");
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
    let size = 0;
    while (true) {
      signal?.throwIfAborted();
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > max) throw new Error("PDF job input quota exceeded");
      hash.update(buffer.subarray(0, bytesRead));
      if (output) {
        let offset = 0;
        while (offset < bytesRead) offset += (await output.write(buffer, offset, bytesRead - offset)).bytesWritten;
      }
    }
    const after = await source.stat();
    if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("PDF source changed during hashing");
    await output?.sync();
    return { hash: hash.digest("hex"), size };
  } finally { await source.close(); await output?.close(); }
}
function transaction(db: DatabaseSync, operation: () => void) {
  db.exec("BEGIN IMMEDIATE");
  try { operation(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
}
function save(db: DatabaseSync, m: PdfJobManifest) {
  validate(m);
  db.prepare("INSERT OR REPLACE INTO manifest VALUES (1,?)").run(JSON.stringify(m));
}
function load(db: DatabaseSync): PdfJobManifest {
  const m = parse<PdfJobManifest>(db.prepare("SELECT json FROM manifest WHERE id=1 AND typeof(json)='text' AND length(CAST(json AS BLOB))<=8388608").get()?.json);
  validate(m);
  return m;
}

/** Independent durable book store. Never publishes fragments into a legacy catalog.
 * SQLite manifest/window/vector commits use FULL synchronous rollback journaling.
 * A separate SQLite write reservation is held through the operation, released by OS on crash.
 * Linux/POSIX only; same-user hostile modification is not a sandbox boundary.
 */
export class PdfJobs {
  readonly root: string;
  readonly quotas: PdfJobLimits;
  constructor(root: string, quotas: PdfJobLimits = DEFAULT_PDF_JOB_LIMITS) {
    this.root = resolve(root); this.quotas = structuredClone(quotas); limits(this.quotas);
  }
  private async directory<T>(operation: (root: string) => Promise<T>): Promise<T> {
    if (process.platform !== "linux") throw new Error("PDF durable jobs currently require Linux descriptor-relative storage");
    await ensureDirectorySafe(this.root);
    return withSafeDirectory(this.root, this.root, async root => {
      const info = await lstat(root + "/.");
      if (info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error("PDF job root must be private 0700");
      return operation(root);
    });
  }
  private async locked<T>(id: string, operation: (db: DatabaseSync, path: string) => Promise<T>, create = false): Promise<T> {
    if (!/^book_[a-f0-9]{64}$/.test(id)) throw new Error("Invalid book ID");
    return this.directory(async root => {
      const prefix = join(root, id);
      // SQLite follows leaf paths: open/check all leaves before handing them to SQLite.
      await privateFile(prefix + ".lock", create);
      const newDatabase = await privateFile(prefix + ".sqlite", create);
      for (const suffix of [".lock-journal", ".sqlite-journal", ".sqlite-wal", ".sqlite-shm", ".lock-wal", ".lock-shm"]) {
        try { await privateFile(prefix + suffix); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      }
      await this.physicalQuota(prefix, (this.quotas.maxStorageBytes - 1024 * 1024) / 2);
      const lock = new DatabaseSync(prefix + ".lock");
      let db: DatabaseSync | undefined;
      try {
        checkPages(lock, 1024 * 1024);
        checkSchema(lock, true);
        db = new DatabaseSync(prefix + ".sqlite");
        checkPages(db, (this.quotas.maxStorageBytes - 1024 * 1024) / 2);
        if (newDatabase) checkSchema(db, true); else checkSchema(db);
        lock.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
        db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0");
        if (newDatabase) db.exec(SCHEMA);
        return await operation(db, prefix);
      } finally { db?.close(); lock.close(); }
    });
  }
  private async physicalQuota(prefix: string, maxDatabase: number) {
    let total = 0;
    for (const suffix of [".sqlite", ".lock", ".sqlite-journal", ".lock-journal", ".sqlite-wal", ".sqlite-shm", ".lock-wal", ".lock-shm"]) {
      try {
        const { size } = await lstat(prefix + suffix); total += size;
        if ((suffix === ".sqlite" && size > maxDatabase) || (suffix === ".lock" && size > 1024 * 1024)) throw new Error("PDF job database storage quota exceeded");
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    if (total > this.quotas.maxStorageBytes) throw new Error("PDF job database storage quota exceeded");
  }
  async start(sourceRoot: string, path: string, signal?: AbortSignal): Promise<PdfJobManifest> {
    // Stream once into a random private spool; no all-source allocation and no URL input.
    await assertNoSymlinkPath(sourceRoot, path);
    return this.directory(async root => {
      const temporary = join(root, `spool-${randomUUID()}`);
      try {
        const source = await withSafeDirectory(sourceRoot, dirname(resolve(path)), stable => digest(join(stable, basename(path)), this.quotas.maxInputBytes, signal, temporary));
        const id = `book_${source.hash}`;
        return await this.locked(id, async (db, prefix) => {
          if (db.prepare("SELECT count(*) AS n FROM manifest").get()?.n !== 0) {
            const m = load(db);
            if (m.sourceHash !== source.hash || m.sourceBytes !== source.size || JSON.stringify(m.limits) !== JSON.stringify(this.quotas)) throw new Error("PDF job source/quota identity drift");
            await this.verify(db, prefix, m, signal);
            return m;
          }
          // Never replace orphan source bytes. A crash between rename and manifest is recoverable only after hash validation.
          try {
            await privateFile(prefix + ".pdf");
            const old = await digest(prefix + ".pdf", this.quotas.maxInputBytes, signal);
            if (old.hash !== source.hash || old.size !== source.size) throw new Error("Orphan PDF spool identity mismatch");
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
            await rename(temporary, prefix + ".pdf");
            const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY); try { await directory.sync(); } finally { await directory.close(); }
          }
          const m: PdfJobManifest = { version: VERSION, bookId: id, sourceHash: source.hash, sourceBytes: source.size, limits: this.quotas, totalPages: null, parsedPages: 0, indexedWindows: 0, batchOffset: 0, space: null, state: "parsing" };
          transaction(db, () => save(db, m));
          return m;
        }, true);
      } finally { await unlink(temporary).catch(e => { if (e.code !== "ENOENT") throw e; }); }
    });
  }
  private readWindow(db: DatabaseSync, start: number, m: PdfJobManifest): Window {
    const row = db.prepare("SELECT json,hash FROM windows WHERE start=? AND typeof(json)='text' AND length(CAST(json AS BLOB))<=8388608 AND typeof(hash)='text' AND length(CAST(hash AS BLOB))=64").get(start);
    const w = parse<Window>(row?.json);
    if (sha256(String(row?.json)) !== row?.hash) throw new Error("PDF window checksum mismatch");
    windowRecord(w, start, m); return w;
  }
  private binding(m: PdfJobManifest, w: Window, offset: number) {
    return sha256(JSON.stringify([m.sourceHash, VERSION, space(m.space!), w.start, offset, w.elements.slice(offset, offset + BATCH)]));
  }
  private readBatch(db: DatabaseSync, m: PdfJobManifest, w: Window, offset: number) {
    const row = db.prepare("SELECT json,binding FROM batches WHERE start=? AND offset=? AND typeof(json)='text' AND length(CAST(json AS BLOB))<=8388608 AND typeof(binding)='text' AND length(CAST(binding AS BLOB))=64").get(w.start, offset);
    if (row?.binding !== sha256(this.binding(m, w, offset) + String(row?.json))) throw new Error("PDF vector binding mismatch");
    const result = parse<number[][]>(row.json);
    vectors(result, Math.min(BATCH, w.elements.length - offset), m.space!.dimension); return result;
  }
  private async verify(db: DatabaseSync, prefix: string, m: PdfJobManifest, signal?: AbortSignal, metadataOnly = false) {
    if (m.bookId !== basename(prefix) || JSON.stringify(m.limits) !== JSON.stringify(this.quotas)) throw new Error("PDF job source/quota identity drift");
    const maxDatabase = (m.limits.maxStorageBytes - m.sourceBytes - 1024 * 1024) / 2;
    await this.physicalQuota(prefix, maxDatabase);
    checkPages(db, maxDatabase);
    await privateFile(prefix + ".pdf");
    const source = await digest(prefix + ".pdf", m.limits.maxInputBytes, signal);
    if (source.hash !== m.sourceHash || source.size !== m.sourceBytes) throw new Error("PDF spool identity drift");
    let batchCount = 0;
    for (let start = 1; start <= m.parsedPages; start += 5) {
      signal?.throwIfAborted();
      const w = this.readWindow(db, start, m), ordinal = (start - 1) / 5;
      const covered = ordinal < m.indexedWindows ? w.elements.length : ordinal === m.indexedWindows ? m.batchOffset : 0;
      if (covered > w.elements.length || (covered === w.elements.length && covered > 0 && ordinal === m.indexedWindows)) throw new Error("Invalid PDF partial batch checkpoint");
      for (let offset = 0; offset < covered; offset += BATCH) { if (!metadataOnly) this.readBatch(db, m, w, offset); batchCount++; }
      for (const image of w.images) {
        const bytes = db.prepare("SELECT bytes FROM images WHERE hash=? AND typeof(bytes)='blob' AND length(bytes)<=20971520").get(image.hash)?.bytes;
        if (!(bytes instanceof Uint8Array) || bytes.length > MAX_IMAGE || sha256(bytes) !== image.hash) throw new Error("PDF image checksum mismatch");
      }
    }
    if (db.prepare("SELECT count(*) AS n FROM windows").get()?.n !== Math.ceil(m.parsedPages / 5) || db.prepare("SELECT count(*) AS n FROM batches").get()?.n !== batchCount) throw new Error("Uncommitted or corrupt PDF checkpoint rows");
  }
  /** Metadata-only by default. Optional vectors are visited one batch at a time, with
   * SQL byte-length and numeric backing estimates charged BEFORE fetching/parsing JSON.
   * Metadata-only inspection does not authenticate vector payloads; readers do that separately.
   */
  async inspect(id: string, visit: (window: PdfWindow) => void, options: {
    signal?: AbortSignal;
    vectors?: { maxBytes: number; visit: (elements: PdfWindow["elements"], vectors: number[][]) => void };
  } = {}) {
    return this.locked(id, async (db, prefix) => {
      const m = load(db); await this.verify(db, prefix, m, options.signal, true);
      if (m.state !== "ready" && m.state !== "parsed") throw new Error("Import requires a fully parsed or ready PDF job");
      let remaining = options.vectors?.maxBytes ?? 0;
      if (!Number.isSafeInteger(remaining) || remaining < 0) throw new Error("Invalid vector inspection budget");
      for (let start = 1; start <= m.parsedPages; start += 5) {
        options.signal?.throwIfAborted();
        const w = this.readWindow(db, start, m);
        visit(w);
        if (m.state === "ready" && options.vectors) for (let offset = 0; offset < w.elements.length; offset += BATCH) {
          const elements = w.elements.slice(offset, offset + BATCH);
          const bytes = db.prepare("SELECT length(CAST(json AS BLOB)) AS bytes FROM batches WHERE start=? AND offset=? AND typeof(json)='text'").get(start, offset)?.bytes;
          // Charge serialized data + numeric storage + copied element metadata (not a total V8 heap cap).
          const backing = elements.length * m.space!.dimension * 8 + Buffer.byteLength(JSON.stringify(elements));
          if (typeof bytes !== "number" || bytes > 8388608 || bytes + backing > remaining) throw new Error("Legacy vector import working-set quota exceeded");
          remaining -= bytes + backing;
          options.vectors.visit(elements, this.readBatch(db, m, w, offset));
        }
      }
      return m;
    });
  }
  async status(id: string, signal?: AbortSignal) { return this.locked(id, async (db, prefix) => { const m = load(db); await this.verify(db, prefix, m, signal); return m; }); }
  async resume(id: string, options: { provider?: EmbeddingProvider; signal?: AbortSignal; onProgress?: (m: PdfJobManifest) => void } = {}) {
    return this.locked(id, async (db, prefix) => {
      const m = load(db), signal = options.signal, provider = options.provider;
      const identity = provider ? space(provider.space) : undefined;
      if (provider && m.space && identity !== space(m.space)) throw new Error("PDF job model identity drift");
      await this.verify(db, prefix, m, signal);
      // Bound database plus rollback journal to remaining disk allowance (source + two DB copies + overhead).
      const pages = Math.floor((m.limits.maxStorageBytes - m.sourceBytes - 1024 * 1024) / 2 / 4096);
      if (pages < 16) throw new Error("PDF job storage quota exhausted");
      db.exec(`PRAGMA max_page_count=${pages}`);
      const progress = () => { try { options.onProgress?.(structuredClone(m)); } catch { /* observers cannot break commits */ } };
      const source = await open(prefix + ".pdf", constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        for (let start = m.parsedPages + 1; m.totalPages === null || start <= m.totalPages; start += 5) {
          signal?.throwIfAborted();
          const output = await runWorker({ fd: source.fd, maxBytes: m.limits.maxInputBytes }, start, Date.now() + 30_000, signal);
          const parsed = validatePdfWindow(output, start, m.totalPages ?? undefined, { text: 0, pixels: 0, images: 0 }, Number.MAX_SAFE_INTEGER);
          const w: Window = { start, end: parsed.pages.at(-1)!.page, elements: [], images: [] };
          const pngs = new Map<string, Uint8Array>();
          for (const page of parsed.pages) {
            const ids: string[] = [];
            for (const chunk of chunkRetrievalText(page.text)) {
              const id = `p${start}_e${w.elements.length}`; ids.push(id);
              w.elements.push({ id, page: page.page, text: chunk.text });
            }
            for (const image of page.images) {
              const png = encodePng(image.width, image.height, image.channels, image.data), hash = sha256(png);
              pngs.set(hash, png); w.images.push({ hash, page: page.page, elementIds: [...ids] });
            }
          }
          m.totalPages = parsed.totalPages; m.parsedPages = w.end;
          if (m.parsedPages === m.totalPages) m.state = "parsed";
          windowRecord(w, start, m);
          const json = JSON.stringify(w); if (Buffer.byteLength(json) > MAX_RECORD) throw new Error("PDF window record quota exceeded");
          signal?.throwIfAborted();
          transaction(db, () => {
            db.prepare("INSERT INTO windows VALUES (?,?,?)").run(start, json, sha256(json));
            for (const [hash, bytes] of pngs) db.prepare("INSERT OR IGNORE INTO images VALUES (?,?)").run(hash, bytes);
            save(db, m);
          }); progress();
        }
      } finally { await source.close(); }
      if (!provider || m.state === "ready") return m;
      if (!m.space) { m.space = structuredClone(provider.space); m.state = "indexing"; transaction(db, () => save(db, m)); }
      for (let start = m.indexedWindows * 5 + 1; start <= m.parsedPages; start += 5) {
        const w = this.readWindow(db, start, m);
        for (let offset = m.batchOffset; offset < w.elements.length; offset += BATCH) {
          signal?.throwIfAborted();
          if (space(provider.space) !== identity) throw new Error("PDF job model identity drift");
          const result = await provider.embed(w.elements.slice(offset, offset + BATCH).map(e => e.text), "document");
          signal?.throwIfAborted();
          if (space(provider.space) !== identity) throw new Error("PDF job model identity drift");
          vectors(result, Math.min(BATCH, w.elements.length - offset), m.space.dimension);
          const json = JSON.stringify(result); if (Buffer.byteLength(json) > MAX_RECORD) throw new Error("PDF vector record quota exceeded");
          m.batchOffset = offset + BATCH;
          if (m.batchOffset >= w.elements.length) { m.indexedWindows++; m.batchOffset = 0; }
          transaction(db, () => { db.prepare("INSERT INTO batches VALUES (?,?,?,?)").run(start, offset, json, sha256(this.binding(m, w, offset) + json)); save(db, m); }); progress();
        }
        if (!w.elements.length) { m.indexedWindows++; m.batchOffset = 0; transaction(db, () => save(db, m)); progress(); }
      }
      m.state = "ready"; transaction(db, () => save(db, m)); progress(); return m;
    });
  }
  /** Dedicated ready-book API; incomplete jobs are never queryable, even lexically. Bounded top-k memory. */
  async search(id: string, query: string, limit = 5, signal?: AbortSignal, provider?: EmbeddingProvider) {
    if (!query.trim() || query.length > 8000 || !positive(limit) || limit > 10) throw new Error("Invalid PDF job search");
    return this.locked(id, async (db, prefix) => {
      const m = load(db); if (m.state !== "ready") throw new Error("PDF book is incomplete; resume indexing before search");
      await this.verify(db, prefix, m, signal);
      let queryVector: number[] | undefined;
      if (provider) {
        if (space(provider.space) !== space(m.space!)) throw new Error("PDF job model identity drift");
        signal?.throwIfAborted();
        const result = await provider.embed([query], "query");
        signal?.throwIfAborted();
        if (space(provider.space) !== space(m.space!)) throw new Error("PDF job model identity drift");
        vectors(result, 1, m.space!.dimension); queryVector = result[0]!;
      }
      const terms = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
      const hits: Array<{ bookId: string; sourceHash: string; page: number; text: string; score: number; images: Image[] }> = [];
      for (let start = 1; start <= m.parsedPages; start += 5) {
        signal?.throwIfAborted(); const w = this.readWindow(db, start, m);
        for (let offset = 0; offset < w.elements.length; offset += BATCH) {
          const stored = queryVector ? this.readBatch(db, m, w, offset) : undefined;
          for (const [index, e] of w.elements.slice(offset, offset + BATCH).entries()) {
          const lexical = terms.filter(t => e.text.toLocaleLowerCase().includes(t)).length / terms.length;
          const score = lexical + (queryVector ? Math.max(0, cosine(queryVector, stored![index]!)) : 0);
          if (score) { hits.push({ bookId: m.bookId, sourceHash: m.sourceHash, page: e.page, text: e.text, score, images: w.images.filter(i => i.elementIds.includes(e.id)) }); hits.sort((a, b) => b.score - a.score || a.page - b.page); hits.length = Math.min(limit, hits.length); }
        }
      }
      }
      return { bookId: m.bookId, totalPages: m.totalPages, state: m.state, retrieval: provider ? "hybrid-weighted" : "lexical", hits };
    });
  }
}

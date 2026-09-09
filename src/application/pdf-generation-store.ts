import { constants } from "node:fs";
import { lstat, open, readdir, mkdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ensureDirectorySafe, withSafeDirectory } from "../core/path-safety.ts";
import { PdfJobs, DEFAULT_PDF_JOB_LIMITS } from "./pdf-jobs.ts";
import type { PdfJobLimits, PdfWindow } from "./pdf-jobs.ts";
import { HttpEmbeddingProvider } from "../adapters/models/http-embedding.ts";
import type { EmbeddingProvider, EmbeddingSpace } from "../domain/retrieval.ts";
import { cosine } from "./rank-evidence.ts";

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const UUID = /^[a-f0-9-]{36}$/;
const SCHEMA = "CREATE TABLE registry(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL); CREATE TABLE vectors(generation TEXT,ordinal INTEGER,json TEXT NOT NULL,binding TEXT NOT NULL,PRIMARY KEY(generation,ordinal))";
const schemaSql = "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name";
const reference = new DatabaseSync(":memory:"); reference.exec(SCHEMA);
const expectedSchema = JSON.stringify(reference.prepare(schemaSql).all()); reference.close();
const MAX_REGISTRY = 1024 * 1024;
const MAX_VECTOR = 2 * 1024 * 1024;
const LEASE_MS = 60_000;
// Explicit working-set ceiling; this implementation does not claim unbounded book support.
const MAX_CAPTURE_METADATA = 64 * 1024 * 1024;
// Per-batch streaming ceiling for legacy imports. The complete vector store is
// persisted in a private staging SQLite database instead of held in the heap.
const MAX_IMPORT_VECTORS = 64 * 1024 * 1024;
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error("Invalid generation registry record");
}
function integer(n: unknown, max = Number.MAX_SAFE_INTEGER): n is number { return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= max; }
function json<T>(raw: unknown, max = MAX_REGISTRY): T {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > max) throw new Error("Registry record quota exceeded");
  try { return JSON.parse(raw) as T; } catch { throw new Error("Malformed registry JSON"); }
}
export function embeddingIdentity(s: EmbeddingSpace): string {
  exact(s, ["provider", "model", "revision", "dimension", "queryInstruction", "documentInstruction"]);
  for (const key of ["provider", "model", "revision", "queryInstruction", "documentInstruction"] as const) {
    if (typeof s[key] !== "string" || s[key].length > 8192 || (!key.endsWith("Instruction") && !s[key].trim())) throw new Error("Invalid embedding space");
  }
  if (!integer(s.dimension, 8192) || s.dimension === 0) throw new Error("Invalid embedding dimension");
  return JSON.stringify([s.provider, s.model, s.revision, s.dimension, s.queryInstruction, s.documentInstruction]);
}
export interface ModelProfile {
  id: string; revision: number; endpoint: string; kind: "openai" | "wemm";
  space: EmbeddingSpace; credentialEnv: string | null;
}
export type ProfileInput = Omit<ModelProfile, "revision">;
export function validateProfile(p: ModelProfile) {
  exact(p, ["id", "revision", "endpoint", "kind", "space", "credentialEnv"]);
  if (!ID.test(p.id) || !integer(p.revision) || p.revision < 1 || !["openai", "wemm"].includes(p.kind)) throw new Error("Invalid model profile");
  embeddingIdentity(p.space);
  if (typeof p.endpoint !== "string" || p.endpoint.length > 2048) throw new Error("Invalid profile endpoint");
  let url: URL; try { url = new URL(p.endpoint); } catch { throw new Error("Invalid profile endpoint"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Profile endpoint requires HTTPS or loopback HTTP, without credentials/query/fragment");
  if (p.credentialEnv !== null && (typeof p.credentialEnv !== "string" || !/^PI_KS_PROFILE_[A-Z][A-Z0-9_]{0,95}$/.test(p.credentialEnv))) throw new Error("Credentials must reference a trusted PI_KS_PROFILE_* environment variable");
}
export function profileSpace(profile: ModelProfile): EmbeddingSpace {
  validateProfile(profile);
  return { ...profile.space, provider: `${profile.space.provider}|${profile.kind}|${new URL(profile.endpoint).href}` };
}
/** Caller must separately approve this exact profile and purpose. No keys in durable records. */
export function profileProvider(profile: ModelProfile, env: Readonly<NodeJS.ProcessEnv>, purpose: "query" | "document", approved: boolean): EmbeddingProvider {
  validateProfile(profile);
  if (!approved) throw new Error("Profile embedding egress denied");
  const key = profile.credentialEnv === null ? undefined : env[profile.credentialEnv];
  if (profile.credentialEnv !== null && !key) throw new Error("Profile credential environment variable is unavailable");
  if (key !== undefined && !/^[\x21-\x7e]+$/.test(key)) throw new Error("Invalid profile credential header");
  const transport = new HttpEmbeddingProvider({ endpoint: profile.endpoint, kind: profile.kind, space: profile.space, approved, allowedPurposes: [purpose], ...(key ? { apiKey: key } : {}) });
  return { space: transport.space, async embed(texts, purpose) {
    try { return await transport.embed(texts, purpose); }
    catch { throw new Error("Profile embedding request failed"); } // Never expose transport messages or causes.
  } };
}
export interface Generation {
  id: string; bookId: string; profile: ModelProfile | null; space: EmbeddingSpace;
  state: "paused" | "running" | "failed" | "cancelled" | "ready";
  checkpoint: number; totalBatches: number; lease: { token: string; until: number } | null;
}
interface Book { id: string; capture: string; sourceHash: string; active: string | null; epoch: number }
interface Registry { version: "pdf-generations-v1"; profiles: ModelProfile[]; selected: { id: string; revision: number } | null; books: Book[]; generations: Generation[] }
function empty(): Registry { return { version: "pdf-generations-v1", profiles: [], selected: null, books: [], generations: [] }; }
function validate(r: Registry) {
  exact(r, ["version", "profiles", "selected", "books", "generations"]);
  if (r.version !== "pdf-generations-v1" || !Array.isArray(r.profiles) || !Array.isArray(r.books) || !Array.isArray(r.generations) || r.profiles.length > 256 || r.books.length > 128 || r.generations.length > 1024) throw new Error("Invalid registry version/quota");
  const profiles = new Set<string>(), books = new Set<string>(), generations = new Set<string>();
  for (const p of r.profiles) { validateProfile(p); const key = `${p.id}:${p.revision}`; if (profiles.has(key)) throw new Error("Duplicate profile revision"); profiles.add(key); }
  if (r.selected !== null) { exact(r.selected, ["id", "revision"]); if (!profiles.has(`${r.selected.id}:${r.selected.revision}`)) throw new Error("Missing selected profile"); }
  for (const b of r.books) {
    exact(b, ["id", "capture", "sourceHash", "active", "epoch"]);
    if (!HASH.test(b.sourceHash) || b.id !== `book_${b.sourceHash}` || !UUID.test(b.capture) || !integer(b.epoch) || books.has(b.id)) throw new Error("Invalid book registry"); books.add(b.id);
  }
  for (const g of r.generations) {
    exact(g, ["id", "bookId", "profile", "space", "state", "checkpoint", "totalBatches", "lease"]);
    embeddingIdentity(g.space);
    if (!UUID.test(g.id) || generations.has(g.id) || !books.has(g.bookId) || !["paused", "running", "failed", "cancelled", "ready"].includes(g.state) || !integer(g.totalBatches) || !integer(g.checkpoint, g.totalBatches) || (g.state === "ready" && g.checkpoint !== g.totalBatches)) throw new Error("Invalid generation checkpoint");
    generations.add(g.id);
    if (g.profile !== null) { validateProfile(g.profile); if (!r.profiles.some(p => JSON.stringify(p) === JSON.stringify(g.profile)) || embeddingIdentity(profileSpace(g.profile)) !== embeddingIdentity(g.space)) throw new Error("Profile snapshot drift"); }
    if (g.lease !== null) { exact(g.lease, ["token", "until"]); if (!UUID.test(g.lease.token) || !integer(g.lease.until) || g.state !== "running") throw new Error("Invalid run lease"); }
    if ((g.state === "running") !== (g.lease !== null)) throw new Error("Invalid run state");
  }
  for (const b of r.books) if (b.active !== null && !r.generations.some(g => g.id === b.active && g.bookId === b.id && g.state === "ready")) throw new Error("Invalid active generation binding");
}
async function regular(path: string, max: number, privateMode: boolean, create = false) {
  let fresh = false;
  if (create) {
    try { const f = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); await f.close(); fresh = true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  }
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const s = await f.stat(); if (!s.isFile() || s.nlink !== 1 || s.size > max || s.uid !== process.getuid?.() || (privateMode && (s.mode & 0o077))) throw new Error("Unsafe generation file or storage quota"); }
  finally { await f.close(); }
  return fresh;
}
async function copyFileSafe(from: string, to: string, max: number) {
  await regular(from, max, false);
  const source = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW), target = await open(to, "wx", 0o600);
  try {
    const before = await source.stat(), buffer = Buffer.alloc(65536); let total = 0;
    while (true) { const { bytesRead } = await source.read(buffer); if (!bytesRead) break; total += bytesRead; if (total > max) throw new Error("Import quota exceeded"); let offset = 0; while (offset < bytesRead) offset += (await target.write(buffer, offset, bytesRead - offset)).bytesWritten; }
    const after = await source.stat(); if (before.size !== total || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("Legacy file changed during import");
    await target.sync();
  } finally { await source.close(); await target.close(); }
}

/** Linux, private local store. SQLite locks exist ONLY inside synchronous control/checkpoint transactions.
 * Leases fence stale HTTP completions; explicit resume can take over an expired lease after a crash.
 */
export class PdfGenerations {
  readonly root: string;
  readonly quotas: PdfJobLimits;
  constructor(root: string, quotas: PdfJobLimits = DEFAULT_PDF_JOB_LIMITS) {
    this.root = resolve(root); this.quotas = structuredClone(quotas);
    if (!integer(quotas.maxInputBytes) || !integer(quotas.maxStorageBytes) || quotas.maxInputBytes < 1 || quotas.maxStorageBytes < quotas.maxInputBytes + 1048576) throw new Error("Invalid generation quotas");
  }
  private async directory<T>(operation: (root: string) => Promise<T>) {
    if (process.platform !== "linux") throw new Error("PDF generations require Linux");
    await ensureDirectorySafe(this.root);
    return withSafeDirectory(this.root, this.root, async root => {
      const info = await lstat(root + "/."); if (info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error("Generation root must be private 0700; permissions are never changed automatically");
      return operation(root);
    });
  }
  private async control<T>(operation: (r: Registry, db: DatabaseSync) => T, write = false): Promise<T> {
    return this.directory(async root => {
      const path = join(root, "registry.sqlite"), max = Math.floor(this.quotas.maxStorageBytes / 4);
      await regular(path, max, true, true);
      for (const suffix of ["-journal", "-wal", "-shm"]) {
        try { await regular(path + suffix, max, true); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      }
      const db = new DatabaseSync(path);
      try {
        const initialPageSize = db.prepare("PRAGMA page_size").get()?.page_size;
        const initialPageCount = db.prepare("PRAGMA page_count").get()?.page_count;
        if (initialPageSize !== 4096 || typeof initialPageCount !== "number" || initialPageCount * initialPageSize > max) throw new Error("Registry page quota exceeded");
        db.exec(`PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; PRAGMA max_page_count=${Math.floor(max / 4096)}; BEGIN IMMEDIATE`);
        const n = db.prepare("SELECT count(*) AS n FROM sqlite_schema").get()?.n;
        if (typeof n !== "number" || n > 3 || db.prepare("SELECT 1 FROM sqlite_schema WHERE length(CAST(sql AS BLOB))>4096 LIMIT 1").get()) throw new Error("Unknown generation schema");
        const schema = JSON.stringify(db.prepare(schemaSql).all());
        if (schema !== "[]" && schema !== expectedSchema) throw new Error("Unknown generation schema");
        if (schema === "[]") db.exec(SCHEMA);
        if (db.prepare("SELECT count(*) AS n FROM registry").get()?.n === 0) {
          if (db.prepare("SELECT count(*) AS n FROM vectors").get()?.n !== 0) throw new Error("Incomplete registry contains vectors");
          db.prepare("INSERT INTO registry VALUES(1,?)").run(JSON.stringify(empty()));
        }
        db.exec("COMMIT");
        const pageSize = db.prepare("PRAGMA page_size").get()?.page_size;
        const pageCount = db.prepare("PRAGMA page_count").get()?.page_count;
        if (pageSize !== 4096 || typeof pageCount !== "number" || pageCount * pageSize > max) throw new Error("Registry page quota exceeded");
        db.exec(`PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=${Math.floor(max / 4096)}`);
        db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
        try {
          const r = json<Registry>(db.prepare("SELECT json FROM registry WHERE id=1 AND length(CAST(json AS BLOB))<=1048576").get()?.json); validate(r);
          const result = operation(r, db);
          if (write) { validate(r); const encoded = JSON.stringify(r); if (Buffer.byteLength(encoded) > MAX_REGISTRY) throw new Error("Registry quota exceeded"); db.prepare("UPDATE registry SET json=? WHERE id=1").run(encoded); }
          db.exec("COMMIT"); return structuredClone(result);
        } catch (e) { db.exec("ROLLBACK"); throw e; }
      } finally { db.close(); }
    });
  }
  async profiles() { return this.control(r => ({ profiles: r.profiles, selected: r.selected })); }
  async addProfile(input: ProfileInput) {
    // Exact validation rejects apiKey/headers/unknown fields; only env names are accepted.
    exact(input, ["id", "endpoint", "kind", "space", "credentialEnv"]);
    return this.control(r => {
      const p: ModelProfile = { ...structuredClone(input), revision: Math.max(0, ...r.profiles.filter(p => p.id === input.id).map(p => p.revision)) + 1 };
      validateProfile(p); r.profiles.push(p); return p;
    }, true);
  }
  async selectProfile(id: string, revision: number) {
    return this.control(r => { if (!r.profiles.some(p => p.id === id && p.revision === revision)) throw new Error("Unknown profile revision"); r.selected = { id, revision }; return r.selected; }, true);
  }
  async selectedProfile() {
    return this.control(r => { const p = r.profiles.find(p => p.id === r.selected?.id && p.revision === r.selected.revision); if (!p) throw new Error("Select a model profile first"); return p; });
  }
  async status(bookId: string) { return this.control(r => ({ book: this.book(r, bookId), generations: r.generations.filter(g => g.bookId === bookId) })); }
  private book(r: Registry, id: string) { const b = r.books.find(b => b.id === id); if (!b) throw new Error("Unknown imported PDF book"); return b; }
  private generation(r: Registry, id: string) { const g = r.generations.find(g => g.id === id); if (!g) throw new Error("Unknown PDF generation"); return g; }
  async generationSnapshot(id: string) { return this.control(r => this.generation(r, id)); }
  private capture(book: Book) { return new PdfJobs(join(this.root, book.capture), this.quotas); }
  private binding(g: Generation, ordinal: number, texts: PdfWindow["elements"], raw: string) { return hash(JSON.stringify([g.id, g.bookId, embeddingIdentity(g.space), ordinal, texts, raw])); }
  private checkVectors(raw: number[][], count: number, dimension: number) {
    if (!Array.isArray(raw) || raw.length !== count || raw.some(v => !Array.isArray(v) || v.length !== dimension || v.some(x => typeof x !== "number" || !Number.isFinite(x)) || !v.some(x => x !== 0))) throw new Error("Invalid generation vectors");
  }
  /** Explicit non-destructive import. Originals are opened read-only, even when mode is 0755/0644.
   * Reject live journal/WAL imports; owner must stop legacy writer first. No chmod, no implicit adoption.
   */
  async importLegacy(legacyRoot: string, bookId: string) {
    if (!/^book_[a-f0-9]{64}$/.test(bookId)) throw new Error("Invalid book ID");
    return this.directory(async root => {
      const capture = randomUUID(), stage = join(root, `import-${capture}`), stagingPath = join(root, `import-${capture}.vectors.sqlite`);
      await mkdir(stage, { mode: 0o700 });
      let published = false, staging: DatabaseSync | null = null;
      try {
        await withSafeDirectory(resolve(legacyRoot), resolve(legacyRoot), async source => {
          const names = await readdir(source);
          if (names.some(n => n.startsWith(bookId) && /(?:-journal|-wal|-shm)$/.test(n))) throw new Error("Legacy job has live/recovery sidecars; stop and recover its writer before importing");
          await copyFileSafe(join(source, bookId + ".lock"), join(stage, bookId + ".lock"), 1048576);
          await copyFileSafe(join(source, bookId + ".pdf"), join(stage, bookId + ".pdf"), this.quotas.maxInputBytes);
          await copyFileSafe(join(source, bookId + ".sqlite"), join(stage, bookId + ".sqlite"), this.quotas.maxStorageBytes / 2);
        });
        // Stage validated batches on disk. Holding every high-dimensional vector in
        // an array made a valid large legacy book fail at an arbitrary heap budget.
        const file = await open(stagingPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); await file.close();
        staging = new DatabaseSync(stagingPath);
        staging.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=${Math.floor(this.quotas.maxStorageBytes / 2 / 4096)}; CREATE TABLE batches(ordinal INTEGER PRIMARY KEY,elements TEXT NOT NULL,vectors TEXT NOT NULL); BEGIN IMMEDIATE`);
        const insert = staging.prepare("INSERT INTO batches VALUES(?,?,?)");
        const jobs = new PdfJobs(join(this.root, `import-${capture}`), this.quotas);
        let totalBatches = 0, nextOrdinal = 0;
        try {
          const manifest = await jobs.inspect(bookId, w => {
            totalBatches += Math.ceil(w.elements.length / 4);
          }, { vectors: { maxBytes: MAX_IMPORT_VECTORS, streaming: true, visit: (elements, vectors) => {
            const elementsJson = JSON.stringify(elements), vectorsJson = JSON.stringify(vectors);
            if (Buffer.byteLength(elementsJson) > MAX_IMPORT_VECTORS || Buffer.byteLength(vectorsJson) > MAX_VECTOR) throw new Error("Legacy vector import working-set quota exceeded");
            insert.run(nextOrdinal++, elementsJson, vectorsJson);
          } } });
          if (manifest.state === "ready" && nextOrdinal !== totalBatches) throw new Error("Incomplete legacy vector stream");
          staging.exec("COMMIT"); staging.close(); staging = null;
          await rename(stage, join(root, capture));
          const dir = await open(root, constants.O_RDONLY | constants.O_DIRECTORY); try { await dir.sync(); } finally { await dir.close(); }
          const result = await this.control((r, db) => {
            if (r.books.some(b => b.id === bookId)) throw new Error("Book already imported; original and generations unchanged");
            const b: Book = { id: bookId, capture, sourceHash: manifest.sourceHash, active: null, epoch: 0 }; r.books.push(b);
            if (manifest.state === "ready") {
              const g: Generation = { id: randomUUID(), bookId, profile: null, space: manifest.space!, state: "ready", checkpoint: totalBatches, totalBatches, lease: null };
              const staged = new DatabaseSync(stagingPath);
              try {
                const rows = staged.prepare("SELECT elements,vectors FROM batches WHERE ordinal=?");
                for (let ordinal = 0; ordinal < totalBatches; ordinal++) {
                  const row = rows.get(ordinal);
                  if (!row) throw new Error("Incomplete staged legacy vectors");
                  const elements = json<PdfWindow["elements"]>(row.elements, MAX_IMPORT_VECTORS);
                  const vectors = json<number[][]>(row.vectors, MAX_VECTOR);
                  if (!Array.isArray(elements) || !Array.isArray(vectors)) throw new Error("Malformed staged legacy vectors");
                  this.putBatch(db, g, ordinal, elements, vectors);
                }
                if (staged.prepare("SELECT count(*) AS n FROM batches").get()?.n !== totalBatches) throw new Error("Extra staged legacy vectors");
              } finally { staged.close(); }
              r.generations.push(g); b.active = g.id; b.epoch = 1;
            }
            return { book: b, manifest };
          }, true);
          published = true; return result;
        } catch (error) {
          try { staging?.exec("ROLLBACK"); } catch { /* already closed or never started */ }
          throw error;
        } finally { if (staging) { staging.close(); staging = null; } }
      } finally {
        if (staging) staging.close();
        await rm(stagingPath, { force: true });
        if (!published) { await rm(stage, { recursive: true, force: true }); await rm(join(root, capture), { recursive: true, force: true }); }
      }
    });
  }
  private putBatch(db: DatabaseSync, g: Generation, ordinal: number, elements: PdfWindow["elements"], result: number[][]) {
    this.checkVectors(result, elements.length, g.space.dimension);
    const raw = JSON.stringify(result); if (Buffer.byteLength(raw) > MAX_VECTOR) throw new Error("Vector quota exceeded");
    db.prepare("INSERT INTO vectors VALUES(?,?,?,?)").run(g.id, ordinal, raw, this.binding(g, ordinal, elements, raw));
  }
  private readBatch(db: DatabaseSync, g: Generation, ordinal: number, elements: PdfWindow["elements"]) {
    const row = db.prepare("SELECT json,binding FROM vectors WHERE generation=? AND ordinal=? AND length(CAST(json AS BLOB))<=2097152 AND length(CAST(binding AS BLOB))=64").get(g.id, ordinal);
    const result = json<number[][]>(row?.json, MAX_VECTOR);
    if (row?.binding !== this.binding(g, ordinal, elements, String(row?.json))) throw new Error("Generation vector binding drift");
    this.checkVectors(result, elements.length, g.space.dimension); return result;
  }
  private async windows(book: Book) {
    const windows: PdfWindow[] = []; let bytes = 0;
    const manifest = await this.capture(book).inspect(book.id, w => { bytes += Buffer.byteLength(JSON.stringify(w)); if (bytes > MAX_CAPTURE_METADATA) throw new Error("Capture metadata working-set quota exceeded"); windows.push(w); });
    return { windows, manifest };
  }
  async reindex(bookId: string, profile: ModelProfile, approved: boolean) {
    if (!approved) throw new Error("Index approval denied"); validateProfile(profile);
    const book = await this.control(r => this.book(r, bookId)), { windows } = await this.windows(book);
    const totalBatches = windows.reduce((n, w) => n + Math.ceil(w.elements.length / 4), 0);
    return this.control(r => {
      this.book(r, bookId);
      if (!r.profiles.some(p => JSON.stringify(p) === JSON.stringify(profile))) throw new Error("Unknown profile snapshot");
      const g: Generation = { id: randomUUID(), bookId, profile: structuredClone(profile), space: profileSpace(profile), state: "paused", checkpoint: 0, totalBatches, lease: null };
      r.generations.push(g); return g;
    }, true);
  }
  async associateProfile(id: string, profile: ModelProfile, approved: boolean) {
    if (!approved) throw new Error("Profile association approval denied");
    profile = structuredClone(profile); validateProfile(profile);
    return this.control(r => {
      const g = this.generation(r, id);
      if (g.state !== "ready" || g.profile !== null) throw new Error("Only unassociated ready imports can bind a profile");
      if (!r.profiles.some(p => JSON.stringify(p) === JSON.stringify(profile))) throw new Error("Unknown profile snapshot");
      if (embeddingIdentity(profileSpace(profile)) !== embeddingIdentity(g.space)) throw new Error("Legacy profile identity mismatch");
      g.profile = structuredClone(profile); return g;
    }, true);
  }
  async stop(id: string, state: "paused" | "cancelled") {
    return this.control(r => { const g = this.generation(r, id); if (g.state === "ready") throw new Error("Cannot stop a ready generation"); if (g.state === "cancelled" && state !== "cancelled") throw new Error("Cancelled generation is terminal"); g.state = state; g.lease = null; return g; }, true);
  }
  async resume(id: string, provider: EmbeddingProvider, approved: boolean, signal?: AbortSignal) {
    if (!approved) throw new Error("Index approval denied"); signal?.throwIfAborted();
    const identity = embeddingIdentity(provider.space), token = randomUUID();
    const initial = await this.control(r => {
      const g = this.generation(r, id);
      if (identity !== embeddingIdentity(g.space)) throw new Error("Generation model identity drift");
      if (g.state === "cancelled") throw new Error("Cancelled generation is terminal; create a new reindex");
      if (g.lease && g.lease.until > Date.now()) throw new Error("Generation already running; pause or wait for expired crash lease");
      if (g.state !== "ready") { g.state = "running"; g.lease = { token, until: Date.now() + LEASE_MS }; }
      return { g, book: this.book(r, g.bookId) };
    }, true);
    if (initial.g.state === "ready") return initial.g;
    try {
      const { windows } = await this.windows(initial.book);
      let ordinal = 0;
      for (const w of windows) for (let offset = 0; offset < w.elements.length; offset += 4, ordinal++) {
        const elements = w.elements.slice(offset, offset + 4);
        let pending: Promise<number[][]> | undefined;
        const work = await this.control((r, db) => {
          const g = this.generation(r, id); this.owned(g, token);
          if (ordinal < g.checkpoint) { this.readBatch(db, g, ordinal, elements); return false; }
          if (ordinal !== g.checkpoint) throw new Error("Generation checkpoint drift");
          g.lease!.until = Date.now() + LEASE_MS;
          signal?.throwIfAborted(); if (embeddingIdentity(provider.space) !== identity) throw new Error("Generation model identity drift");
          // Synchronous provider entry linearizes with stop; never await the response under lock.
          pending = provider.embed(elements.map(e => e.text), "document");
          void pending.catch(() => {}); // Also consumed if validation/COMMIT/cleanup fails.
          return true;
        }, true);
        if (!work) continue;
        signal?.throwIfAborted(); if (embeddingIdentity(provider.space) !== identity) throw new Error("Generation model identity drift");
        // Entry already happened under control; only the response wait is outside it.
        const result = await pending!;
        signal?.throwIfAborted(); if (embeddingIdentity(provider.space) !== identity) throw new Error("Generation model identity drift");
        await this.control((r, db) => { const g = this.generation(r, id); this.owned(g, token); if (g.checkpoint !== ordinal) throw new Error("Generation checkpoint drift"); this.putBatch(db, g, ordinal, elements, result); g.checkpoint++; g.lease!.until = Date.now() + LEASE_MS; }, true);
      }
      await this.validateGeneration(id);
      return await this.control(r => { const g = this.generation(r, id); this.owned(g, token); if (g.checkpoint !== g.totalBatches) throw new Error("Incomplete generation"); g.state = "ready"; g.lease = null; return g; }, true);
    } catch (e) {
      await this.control(r => { const g = this.generation(r, id); if (g.lease?.token === token) { g.state = signal?.aborted ? "paused" : "failed"; g.lease = null; } }, true);
      throw e; // Never persist transport messages, payloads or credentials.
    }
  }
  private owned(g: Generation, token: string) { if (g.state !== "running" || g.lease?.token !== token || g.lease.until < Date.now()) throw new Error("Generation run fenced; inspect status and explicitly resume"); }
  private async validateGeneration(id: string) {
    const snapshot = await this.control(r => { const g = this.generation(r, id); return { g, book: this.book(r, g.bookId) }; });
    const { windows } = await this.windows(snapshot.book);
    return this.control((r, db) => {
      const g = this.generation(r, id); let ordinal = 0;
      for (const w of windows) for (let offset = 0; offset < w.elements.length; offset += 4) this.readBatch(db, g, ordinal++, w.elements.slice(offset, offset + 4));
      if (ordinal !== g.totalBatches || g.checkpoint !== ordinal || db.prepare("SELECT count(*) AS n FROM vectors WHERE generation=?").get(g.id)?.n !== ordinal) throw new Error("Incomplete or extra generation vectors");
      return g;
    });
  }
  /** Also used for rollback: callers supply the currently observed active ID AND epoch (ABA-safe). */
  async activate(bookId: string, target: string, expectedActive: string | null, expectedEpoch: number) {
    const verified = await this.validateGeneration(target);
    if (verified.bookId !== bookId || verified.state !== "ready") throw new Error("Only complete ready generation can activate");
    return this.control(r => {
      const b = this.book(r, bookId), g = this.generation(r, target);
      if (b.active !== expectedActive || b.epoch !== expectedEpoch) throw new Error("Active generation CAS conflict");
      if (g.bookId !== bookId || g.state !== "ready") throw new Error("Invalid activation target");
      b.active = target; b.epoch++; return b;
    }, true);
  }
  async search(bookId: string, query: string, limit = 5, provider?: EmbeddingProvider) {
    if (!query.trim() || query.length > 8000 || !integer(limit, 10) || limit < 1) throw new Error("Invalid generation search");
    const snapshot = await this.control(r => { const b = this.book(r, bookId); if (!b.active) throw new Error("No active ready index"); return { book: b, g: this.generation(r, b.active) }; });
    let vector: number[] | undefined;
    if (provider) {
      if (embeddingIdentity(provider.space) !== embeddingIdentity(snapshot.g.space)) throw new Error("Query model identity drift");
      const result = await provider.embed([query], "query");
      if (embeddingIdentity(provider.space) !== embeddingIdentity(snapshot.g.space)) throw new Error("Query model identity drift");
      this.checkVectors(result, 1, snapshot.g.space.dimension); vector = result[0]!;
    }
    const { windows } = await this.windows(snapshot.book), terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    return this.control((_r, db) => {
      let ordinal = 0;
      const hits: Array<{ page: number; text: string; score: number; images: PdfWindow["images"] }> = [];
      for (const w of windows) for (let offset = 0; offset < w.elements.length; offset += 4) {
        const elements = w.elements.slice(offset, offset + 4), stored = this.readBatch(db, snapshot.g, ordinal++, elements);
        for (const [i, e] of elements.entries()) {
          const score = terms.filter(t => e.text.toLocaleLowerCase().includes(t)).length / terms.length + (vector ? Math.max(0, cosine(vector, stored[i]!)) : 0);
          if (score) { hits.push({ page: e.page, text: e.text, score, images: w.images.filter(image => image.elementIds.includes(e.id)) }); hits.sort((a, b) => b.score - a.score || a.page - b.page); hits.length = Math.min(hits.length, limit); }
        }
      }
      return { bookId, generationId: snapshot.g.id, epoch: snapshot.book.epoch, space: snapshot.g.space, hits };
    });
  }
}

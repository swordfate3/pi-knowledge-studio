/** Independent evaluator. Gold never enters the corpus or model payloads.
 * node --experimental-strip-types scripts/evaluate-public-corpus.ts acquire|freeze|score [--live]
 * Inputs/artifacts are intentionally outside the checkout; see docs/public-corpus-evaluation.md.
 */
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, dirname, posix } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { KnowledgeRuntime } from "../src/application/knowledge-runtime.ts";
import { HttpEmbeddingProvider } from "../src/adapters/models/http-embedding.ts";
import type { CapturedDocument } from "../src/domain/retrieval.ts";
const root = "/tmp/studio-public-eval";
const base = "https://raw.githubusercontent.com/mindspore-ai/docs/master/";
const hash = (x: string | Uint8Array) =>
 createHash("sha256").update(x).digest("hex");
function parseJson(text: string) {
 try {
  return JSON.parse(text);
 } catch (cause) {
  throw new Error("Invalid evaluator JSON", { cause });
 }
}
const json = async (p: string) =>
 parseJson(await readFile(join(root, p), "utf8"));
async function save(p: string, value: unknown) {
 await mkdir(dirname(join(root, p)), { recursive: true });
 await writeFile(join(root, p), JSON.stringify(value, null, 2) + "\n");
}
async function seal(value: unknown) {
 const bytes = JSON.stringify(value, null, 2) + "\n";
 const digest = hash(bytes);
 await mkdir(join(root, "objects"), { recursive: true });
 const path = join(root, "objects", digest + ".json");
 try {
  await writeFile(path, bytes, { flag: "wx", mode: 0o444 });
 } catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  if (hash(await readFile(path)) !== digest)
   throw new Error("Object collision");
 }
 return digest;
}
type Entry = { id: string; path: string; sha256: string };
const manifest: Entry[] = await json("manifest.json");
const previous = await json("acquisition.json").catch(() => ({ attempts: [] }));
const attempts: {
 path: string;
 attempt: number;
 ms: number;
 sha256?: string;
 error?: string;
}[] = [...previous.attempts];
async function acquire(path: string, expected?: string) {
 const dest = join(root, "original", path);
 await mkdir(dirname(dest), { recursive: true });
 try {
  const bytes = await readFile(dest);
  if (expected && hash(bytes) !== expected)
   throw new Error("Cached checksum mismatch");
  return hash(bytes);
 } catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
 }
 // One initial attempt plus exactly two bounded retries; TLS verification stays enabled.
 for (let n = attempts.filter((a) => a.path === path).length; n < 3; n++) {
  const started = Date.now();
  try {
   const bytes = execFileSync(
    "curl",
    [
     "--fail",
     "--silent",
     "--show-error",
     "--noproxy",
     "*",
     "--proto",
     "=https",
     "--connect-timeout",
     "10",
     "--max-time",
     "30",
     base + path,
    ],
    { maxBuffer: 20 * 1024 * 1024, timeout: 32000 },
   );
   const digest = hash(bytes);
   if (expected && digest !== expected)
    throw new Error("Checksum mismatch " + path);
   await writeFile(dest, bytes, { flag: "wx" });
   attempts.push({
    path,
    attempt: n + 1,
    ms: Date.now() - started,
    sha256: digest,
   });
   return digest;
  } catch (e) {
   attempts.push({
    path,
    attempt: n + 1,
    ms: Date.now() - started,
    error: String(e),
   });
   if (String(e).includes("Checksum mismatch")) throw e;
  }
 }
 throw new Error("Acquisition exhausted: " + path);
}
async function codeHashes() {
 const result: Record<string, string> = {};
 async function walk(p: string) {
  for (const ent of await readdir(p, { withFileTypes: true })) {
   const f = join(p, ent.name);
   if (ent.isDirectory()) await walk(f);
   else result[f] = hash(await readFile(f));
  }
 }
 await walk("src");
 for (const f of [
  "package.json",
  "package-lock.json",
  "scripts/evaluate-public-corpus.ts",
 ])
  result[f] = hash(await readFile(f));
 return result;
}
const command = process.argv[2];
if (command === "acquire") {
 const exclusions: unknown[] = [];
 const originals: unknown[] = [];
 const transforms: unknown[] = [];
 for (const entry of manifest) {
  try {
   originals.push({
    ...entry,
    actual: await acquire(entry.path, entry.sha256),
   });
  } catch (e) {
   exclusions.push({ id: entry.id, path: entry.path, error: String(e) });
  }
 }
 for (const entry of manifest.filter((e) => e.path.endsWith(".md"))) {
  try {
   const raw = await readFile(join(root, "original", entry.path), "utf8");
   if (hash(raw) !== entry.sha256) throw new Error("Source mismatch");
   const changes: unknown[] = [];
   const lines = raw.split("\n");
   for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (
     /!\[.*\]\([^)]*\.svg\)/.test(line) &&
     /\[!\[.*\]\([^)]*\.svg\)\]/.test(line)
    ) {
     changes.push({
      line: i + 1,
      before: line,
      after: "",
      reason: "source-view badge removed, blank line retained",
     });
     lines[i] = "";
     continue;
    }
    const refs = [...line.matchAll(/!\[([^\]]*)\]\(([^\s()]+)\)/g)];
    for (const m of refs) {
     const target = m[2]!;
     let path: string;
     const mirror =
      "https://mindspore-website.obs.cn-north-4.myhuaweicloud.com/website-images/master/";
     if (target.startsWith(base)) path = target.slice(base.length);
     else if (target.startsWith(mirror)) path = target.slice(mirror.length);
     else if (/^https?:/.test(target))
      throw new Error("Unapproved image URL " + target);
     else path = posix.normalize(posix.join(posix.dirname(entry.path), target));
     if (path.startsWith("../") || !/\.(png|jpg|jpeg|webp)$/i.test(path))
      throw new Error("Unsupported figure " + target);
     const known = manifest.find((e) => e.path === path);
     const digest = await acquire(path, known?.sha256);
     const local = "assets/" + digest + posix.extname(path);
     const out = join(root, "corpus", posix.dirname(entry.path), local);
     await mkdir(dirname(out), { recursive: true });
     await writeFile(out, await readFile(join(root, "original", path)));
     const replacement = `![${m[1]}](${local})`;
     line = line.replace(m[0], replacement);
     changes.push({
      line: i + 1,
      before: m[0],
      after: replacement,
      originalPath: path,
      sha256: digest,
     });
    }
    lines[i] = line;
   }
   const packaged = lines.join("\n");
   const dest = join(root, "corpus", entry.path);
   await mkdir(dirname(dest), { recursive: true });
   await writeFile(dest, packaged);
   transforms.push({
    id: entry.id,
    path: entry.path,
    rawHash: entry.sha256,
    packagedHash: hash(packaged),
    lineMapping: "identity (badge replaced with empty line)",
    changes,
   });
  } catch (e) {
   exclusions.push({
    id: entry.id,
    path: entry.path,
    error: String(e),
    scope: "whole document",
   });
  }
 }
 await save("acquisition.json", {
  base,
  at: new Date().toISOString(),
  originals,
  transforms,
  exclusions,
  attempts,
  commit: "unresolved; exact content hashes define revision",
 });
 console.log(
  "Acquired",
  originals.length,
  "packaged",
  transforms.length,
  "exclusions",
  exclusions.length,
 );
} else if (command === "freeze") {
 const acquisition = await json("acquisition.json");
 const content: Record<string, string> = {};
 async function archive(p: string) {
  for (const ent of await readdir(join(root, p), { withFileTypes: true })) {
   const f = join(p, ent.name);
   if (ent.isDirectory()) await archive(f);
   else {
    const bytes = await readFile(join(root, f));
    const digest = hash(bytes);
    content[f] = digest;
    await mkdir(join(root, "objects"), { recursive: true });
    try {
     await writeFile(join(root, "objects", digest), bytes, {
      flag: "wx",
      mode: 0o444,
     });
    } catch (e) {
     if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
   }
  }
 }
 await archive("original");
 await archive("corpus");
 const runtime = new KnowledgeRuntime(join(root, "runtime"));
 const imported: { id: string; path: string; document: CapturedDocument }[] =
  [];
 const failures: unknown[] = [];
 for (const t of acquisition.transforms) {
  try {
   if (hash(await readFile(join(root, "corpus", t.path))) !== t.packagedHash)
    throw new Error("Packaged hash mismatch");
   imported.push({
    id: t.id,
    path: t.path,
    document: await runtime.ingest(
     join(root, "corpus"),
     join(root, "corpus", t.path),
    ),
   });
  } catch (e) {
   failures.push({ id: t.id, error: String(e) });
  }
 }
 const gold = await json("gold.json");
 const freeze = {
  at: new Date().toISOString(),
  content,
  code: await codeHashes(),
  git:
   process.env.EVAL_GIT_COMMIT ??
   execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  acquisition,
  goldHash: hash(await readFile(join(root, "gold.json"))),
  imported,
  failures,
  model: {
   endpoint: "http://127.0.0.1:18083/embed",
   model: "tencent/WeMM-Embedding-4B",
   revision: "a28b25c5d18cf71ec46b115e06ea79ab00ee4819",
   dimension: 512,
   queryInstruction: "",
   documentInstruction: "",
  },
  protocol: {
   limit: 10,
   figureLimit: 5,
   reranker: false,
   hints: false,
   visualGold: false,
  },
  gold,
 };
 const digest = await seal(freeze);
 await save("freeze-ref.json", { sha256: digest });
 console.log(
  "Frozen",
  digest,
  "imported",
  imported.length,
  "failures",
  failures,
 );
} else if (command === "score") {
 const ref = await json("freeze-ref.json");
 const bytes = await readFile(join(root, "objects", ref.sha256 + ".json"));
 if (hash(bytes) !== ref.sha256) throw new Error("Freeze corrupt");
 const freeze = parseJson(bytes.toString());
 if (JSON.stringify(await codeHashes()) !== JSON.stringify(freeze.code))
  throw new Error("Implementation changed after freeze");
 if (hash(await readFile(join(root, "gold.json"))) !== freeze.goldHash)
  throw new Error("Gold changed after freeze");
 const runtime = new KnowledgeRuntime(join(root, "runtime"));
 const current = await runtime.list();
 if (
  current.length !== freeze.imported.length ||
  freeze.imported.some(
   (e: { document: CapturedDocument }) =>
    !current.some(
     (d) => d.id === e.document.id && d.revision === e.document.revision,
    ),
  )
 )
  throw new Error("Catalog differs from freeze");
 const imported = freeze.imported as {
  id: string;
  path: string;
  document: CapturedDocument;
 }[];
 const calls: unknown[] = [];
 const tracks: unknown[] = [];
 const provider = new HttpEmbeddingProvider({
  endpoint: freeze.model.endpoint,
  kind: "wemm",
  approved: true,
  space: {
   provider: "wemm",
   model: freeze.model.model,
   revision: freeze.model.revision,
   dimension: 512,
   queryInstruction: "",
   documentInstruction: "",
  },
 });
 const embed = provider.embed.bind(provider);
 provider.embed = async (texts, purpose) => {
  const start = Date.now();
  try {
   const out = await embed(texts, purpose);
   calls.push({
    purpose,
    count: texts.length,
    payloadHash: hash(JSON.stringify(texts)),
    ms: Date.now() - start,
    ok: true,
   });
   return out;
  } catch (e) {
   calls.push({
    purpose,
    count: texts.length,
    ms: Date.now() - start,
    error: String(e),
   });
   throw e;
  }
 };
 for (const mode of process.argv.includes("--live")
  ? ["lexical", "hybrid"]
  : ["lexical"]) {
  if (mode === "hybrid") {
   try {
    await provider.embed(["Public corpus evaluation health check"], "query");
    await runtime.index(provider);
   } catch (e) {
    tracks.push({
     mode,
     error: String(e),
     status: "not scored: health/index failed",
    });
    break;
   }
  }
  const rows = [];
  for (const q of freeze.gold.questions) {
   const eligible = q.supports.filter((s: { doc: string }) =>
    imported.some((e) => e.id === s.doc),
   );
   if (!q.noAnswer && !eligible.length) {
    rows.push({
     id: q.id,
     status: "excluded: supporting documents not imported",
    });
    continue;
   }
   const start = Date.now();
   try {
    const result = await runtime.search(
     q.query,
     10,
     mode === "hybrid" ? provider : undefined,
    );
    const ranked = [...new Set(result.hits.map((h) => h.document.id))];
    const ranks = eligible.map((s: { doc: string }) => {
     const id = imported.find((e) => e.id === s.doc)!.document.id;
     const rank = ranked.indexOf(id);
     return rank < 0 ? 0 : rank + 1;
    });
    const supportHits = eligible.map((s: { doc: string; lines: number[] }) =>
     result.hits.findIndex(
      (h) =>
       h.document.id === imported.find((e) => e.id === s.doc)!.document.id &&
       h.element.locator.kind === "lines" &&
       s.lines.some(
        (l) =>
         h.element.locator.kind === "lines" &&
         l >= h.element.locator.start &&
         l <= h.element.locator.end,
       ),
     ),
    );
    const required = (q.images ?? []).filter((s: { doc: string }) =>
     imported.some((e) => e.id === s.doc),
    );
    const matches = (
     image: (typeof result.bundle.images)[number],
     g: { doc: string; line: number; hash: string },
    ) => {
     const d = imported.find((e) => e.id === g.doc)!.document;
     return (
      image.sourceId === d.id &&
      image.blobHash === g.hash &&
      image.locator.kind === "lines" &&
      image.locator.start === g.line &&
      result.bundle.sources.some(
       (s) => s.id === d.id && s.revisionHash === d.revision,
      )
     );
    };
    const correct = result.bundle.images.filter((i) =>
     required.some((g: { doc: string; line: number; hash: string }) =>
      matches(i, g),
     ),
    ).length;
    const imageRecall = required.length
     ? required.filter((g: { doc: string; line: number; hash: string }) =>
        result.bundle.images.some((i) => matches(i, g)),
       ).length / required.length
     : null;
    const intact = await Promise.all(
     result.bundle.images.map(
      async (i) => hash(await runtime.blobs.get(i.blobHash)) === i.blobHash,
     ),
    );
    rows.push({
     id: q.id,
     status: "ok",
     ms: Date.now() - start,
     noAnswer: !!q.noAnswer,
     documentHit10: ranks.some((r: number) => r > 0) ? 1 : 0,
     documentMRR10: ranks.some((r: number) => r > 0)
      ? 1 / Math.min(...ranks.filter((r: number) => r > 0))
      : 0,
     evidenceRecall10: eligible.length
      ? supportHits.filter((r: number) => r >= 0).length / eligible.length
      : null,
     evidenceMRR10: supportHits.some((r: number) => r >= 0)
      ? 1 / (1 + Math.min(...supportHits.filter((r: number) => r >= 0)))
      : 0,
     imageRecall5: imageRecall,
     correctImages: correct,
     selectedImages: result.bundle.images.length,
     originalHashMatches: intact.filter(Boolean).length,
     abstained: false,
     hits: result.hits.map((h) => ({
      sourceId: h.document.id,
      revision: h.document.revision,
      locator: h.element.locator,
      elementId: h.element.id,
      score: h.score,
     })),
     images: result.bundle.images,
     sources: result.bundle.sources,
    });
   } catch (e) {
    rows.push({
     id: q.id,
     status: "error",
     ms: Date.now() - start,
     error: String(e),
    });
   }
  }
  tracks.push({ mode, rows });
 }
 const result = {
  at: new Date().toISOString(),
  freeze: ref.sha256,
  tracks,
  calls,
  implementationUnchanged:
   JSON.stringify(await codeHashes()) === JSON.stringify(freeze.code),
 };
 const digest = await seal(result);
 await save("latest-result-ref.json", { sha256: digest });
 console.log("Result", digest);
} else throw new Error("Expected acquire|freeze|score [--live]");

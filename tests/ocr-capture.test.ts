import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { KnowledgeRuntime } from "../src/application/knowledge-runtime.ts";
import { captureLocal } from "../src/adapters/parsing/capture-local.ts";
import {
  captureRevision,
  validateCapture,
} from "../src/application/validate-capture.ts";
import { validateEvidence } from "../src/application/validate-evidence.ts";
import { exportPortableDocument } from "../src/adapters/export/portable-export.ts";
import { generateGrounded } from "../src/adapters/models/grounded-model.ts";
import { sha256 } from "../src/adapters/blob/file-blob-store.ts";
import { OCR_WARNING } from "../src/domain/ocr.ts";

const fixture = resolve("tests/fixtures/ocr/bilingual-scanned.pdf");
// Explicit integration invocation fails without prerequisites; default suite stays offline.
const configPath = process.env.PI_KS_OCR_TEST_CONFIG;
test("OCR approval denied before config or CAS access", async () => {
  let writes = 0;
  await assert.rejects(
    captureLocal(
      process.cwd(),
      fixture,
      {
        put: async () => {
          writes++;
          return "";
        },
        get: async () => Buffer.alloc(0),
      },
      undefined,
      { ocr: { approved: false, configPath: "/does-not-exist" } },
    ),
    /OCR_NOT_APPROVED/,
  );
  assert.equal(writes, 0);
});
test("real local bilingual OCR import/search/export/generator evidence chain", {
  skip: !configPath && !process.env.PI_KS_OCR_TEST_REQUIRED,
}, async (t) => {
  assert.ok(
    configPath,
    "PI_KS_OCR_TEST_CONFIG is required for explicit integration run",
  );
  const root = await mkdtemp(join(tmpdir(), "ks-ocr-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const kb = new KnowledgeRuntime(join(root, "kb"));
  const doc = await kb.ingest(process.cwd(), fixture, {
    ocr: { approved: true, configPath },
  });
  assert.match(
    doc.elements[0]!.text,
    /Knowledge retrieval preserves original images/,
  );
  assert.match(
    doc.elements[0]!.text.replace(/\s/g, ""),
    /知识检索保留原始图片/,
  );
  assert.equal(doc.images[0]!.originKind, "page_render");
  assert.ok(
    doc.images[0]!.provenance!.width * doc.images[0]!.provenance!.height <=
      4_000_000,
  );
  assert.deepEqual(await kb.blobs.get(doc.sourceHash), await readFile(fixture));
  const again = await kb.ingest(process.cwd(), fixture, {
    ocr: { approved: true, configPath },
  });
  assert.equal(again.revision, doc.revision);
  const result = await kb.search("知识 检索", 5);
  assert.equal(result.bundle.texts[0]!.provenance!.verification, "unverified");
  validateEvidence(result.bundle, result.document);
  const bad = structuredClone(doc);
  bad.elements[0]!.provenance!.page = 2;
  bad.revision = captureRevision(bad);
  assert.throws(() => validateCapture(bad), /OCR/);
  const missing = structuredClone(result.bundle);
  missing.images = [];
  assert.throws(() => validateEvidence(missing, result.document), /OCR/);
  const extra = structuredClone(result.bundle);
  Object.assign(extra.texts[0]!.provenance!, { executable: "/private" });
  assert.throws(() => validateEvidence(extra, result.document), /OCR/);
  const output = join(root, "export");
  await mkdir(output, { mode: 0o700 });
  for (const excerpts of [true, false]) {
    const path = await exportPortableDocument(
      output,
      result.bundle,
      result.document,
      { documentContent: true, images: true, excerpts },
      kb.blobs,
    );
    const html = await readFile(join(path, "document.html"), "utf8");
    assert.match(html, /Unverified OCR transcript/);
    assert.doesNotMatch(html, /<blockquote>/);
    const evidence = JSON.parse(
      await readFile(join(path, "evidence.json"), "utf8"),
    );
    assert.equal(evidence.excerpts[0].provenance.verification, "unverified");
    assert.equal(Object.hasOwn(evidence.excerpts[0], "text"), excerpts);
    const assets = await readdir(join(path, "assets"));
    assert.deepEqual(assets, [doc.images[0]!.blobHash + ".png"]);
  }
  let sent = false;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      sent = true;
      const request = JSON.parse(String(init.body));
      assert.match(request.messages[0].content, /unverified recognition/);
      const payload = JSON.parse(request.messages[1].content);
      assert.equal(
        payload.bundle.texts[0].provenance.verification,
        "unverified",
      );
      assert.doesNotMatch(
        JSON.stringify(payload),
        /studio-ocr-prereqs|configPath|\/tmp\//,
      );
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify({
                  ...result.document,
                  mode: "model-generated",
                }),
              },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );
  await generateGrounded(
    {
      endpoint: "http://127.0.0.1:7777/chat/completions",
      model: "test",
      approved: true,
    },
    result.bundle,
    result.document.title,
  );
  assert.ok(sent);
  // A corrupt retained transcript fails before export and does not become a quote.
  await assert.rejects(
    exportPortableDocument(
      output,
      result.bundle,
      result.document,
      { documentContent: true, images: true, excerpts: false },
      {
        put: (b) => kb.blobs.put(b),
        get: async (hash) =>
          hash === doc.elements[0]!.provenance!.transcriptHash
            ? Buffer.from("wrong")
            : kb.blobs.get(hash),
      },
    ),
    /integrity/,
  );
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(await readdir(config.tempRoot), []);
  config.files[0].sha256 = "0".repeat(64);
  const corrupt = join(root, "corrupt.json");
  await writeFile(corrupt, JSON.stringify(config), { mode: 0o600 });
  let writes = 0;
  await assert.rejects(
    captureLocal(
      process.cwd(),
      fixture,
      {
        put: async (b) => {
          writes++;
          return sha256(b);
        },
        get: async () => Buffer.alloc(0),
      },
      undefined,
      { ocr: { approved: true, configPath: corrupt } },
    ),
    /OCR_STACK_MISMATCH/,
  );
  assert.equal(writes, 0);
  assert.match(
    result.document.blocks[0]!.kind === "paragraph"
      ? result.document.blocks[0]!.text
      : "",
    /Unverified OCR/,
  );
  assert.ok(OCR_WARNING.length);
});

test("real full-document coverage handles native/scan/overlay; blank fails without CAS publication", {
  skip: !configPath && !process.env.PI_KS_OCR_TEST_REQUIRED,
}, async (t) => {
  assert.ok(configPath);
  const root = await mkdtemp(join(tmpdir(), "ks-ocr-coverage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const kb = new KnowledgeRuntime(join(root, "kb"));
  const mixed = await kb.ingest(
    process.cwd(),
    resolve("tests/fixtures/ocr/mixed.pdf"),
    { ocr: { approved: true, configPath } },
  );
  assert.equal(mixed.images.length, 3);
  assert.deepEqual(
    mixed.images.map((i) => i.provenance!.page),
    [1, 2, 3],
  );
  for (const page of [2, 3])
    assert.match(
      mixed.elements
        .filter((e) => e.provenance!.page === page)
        .map((e) => e.text)
        .join("")
        .replace(/\s/g, ""),
      /知识检索保留原始图片/,
    );
  let writes = 0;
  await assert.rejects(
    captureLocal(
      process.cwd(),
      resolve("tests/fixtures/ocr/blank.pdf"),
      {
        put: async (b) => {
          writes++;
          return sha256(b);
        },
        get: async () => Buffer.alloc(0),
      },
      undefined,
      { ocr: { approved: true, configPath } },
    ),
    /OCR_EMPTY_TRANSCRIPT: page 2/,
  );
  assert.equal(writes, 0);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    kb.ingest(process.cwd(), fixture, {
      ocr: { approved: true, configPath },
      signal: abort.signal,
    }),
  );
  assert.equal((await kb.list()).length, 1);
  const nativePath = resolve("tests/fixtures/ocr/native.pdf");
  const native = await kb.ingest(process.cwd(), nativePath);
  assert.equal(native.parserVersion, "local-text-png-pdf-v2");
  assert.ok(native.elements.every((e) => !e.provenance));
  const expected = sha256(
    JSON.stringify([
      native.sourceHash,
      "local-text-png-pdf-v2",
      native.elements,
      native.images,
    ]),
  );
  assert.equal(native.revision, expected);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(await readdir(config.tempRoot), []);
});

test("real OCR cancellation during rendering/recognition cleans children and publishes nothing", {
  skip: !configPath && !process.env.PI_KS_OCR_TEST_REQUIRED,
}, async (t) => {
  assert.ok(configPath);
  const root = await mkdtemp(join(tmpdir(), "ks-ocr-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const privateTemp = join(root, "temp");
  await mkdir(privateTemp, { mode: 0o700 });
  config.tempRoot = privateTemp;
  const localConfig = join(root, "ocr.json");
  await writeFile(localConfig, JSON.stringify(config), { mode: 0o600 });
  const controller = new AbortController();
  let reachedPrivateInput = false;
  const timer = setInterval(() => {
    void (async () => {
      for (const dir of await readdir(privateTemp)) {
        if ((await readdir(join(privateTemp, dir))).includes("input.pdf")) {
          reachedPrivateInput = true;
          controller.abort();
        }
      }
    })().catch(() => {});
  }, 5);
  let writes = 0;
  try {
    await assert.rejects(
      captureLocal(
        process.cwd(),
        resolve("tests/fixtures/ocr/mixed.pdf"),
        {
          put: async (b) => {
            writes++;
            return sha256(b);
          },
          get: async () => Buffer.alloc(0),
        },
        undefined,
        {
          ocr: { approved: true, configPath: localConfig },
          signal: controller.signal,
        },
      ),
      /OCR_CANCELLED|aborted/,
    );
  } finally {
    clearInterval(timer);
  }
  assert.ok(reachedPrivateInput);
  assert.equal(writes, 0);
  assert.deepEqual(await readdir(privateTemp), []);
  // Missing closure libraries are rejected by loader inspection, not loaded from host fallback.
  config.files = config.files.filter(
    (f: { name: string }) => f.name !== "libc.so.6",
  );
  await writeFile(localConfig, JSON.stringify(config));
  await assert.rejects(
    captureLocal(
      process.cwd(),
      fixture,
      {
        put: async (b) => {
          writes++;
          return sha256(b);
        },
        get: async () => Buffer.alloc(0),
      },
      undefined,
      { ocr: { approved: true, configPath: localConfig } },
    ),
    /OCR_STACK_MISMATCH|OCR_UNAVAILABLE/,
  );
  assert.equal(writes, 0);
  assert.deepEqual(await readdir(privateTemp), []);
});

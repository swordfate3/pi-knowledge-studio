import { getEventListeners } from 'node:events';
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  capturePdf,
  validatePdfWindow,
  PDF_CAPTURE_LIMITATIONS,
} from "../src/adapters/parsing/capture-pdf.ts";
import { validatePng } from "../src/adapters/export/png.ts";
import type { BlobStore } from "../src/ports/blob-store.ts";

// Real PDF objects, streams, byte offsets, xref and trailer; no parser mocks.
function fixture(texts: string[], bitmap = false, fontSize = "12"): Buffer {
  const objects: Buffer[] = [];
  const add = (text: string) => objects.push(Buffer.from(text, "latin1"));
  const imageId = 4 + texts.length * 2;
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(
    `<< /Type /Pages /Count ${texts.length} /Kids [${texts.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] >>`,
  );
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (const [index, text] of texts.entries()) {
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 3 0 R >> ${bitmap ? `/XObject << /Im1 ${imageId} 0 R >>` : ""} >> /Contents ${5 + index * 2} 0 R >>`,
    );
    const stream = `${text ? `BT /F1 ${fontSize} Tf 20 200 Td (${text}) Tj ET\n` : ""}${bitmap ? "q 20 0 0 20 20 20 cm /Im1 Do Q\n" : ""}`;
    add(
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    );
  }
  if (bitmap)
    add(
      "<< /Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 6 >>\nstream\n\xff\x00\x00\x00\xff\x00\nendstream",
    );
  const parts = [Buffer.from("%PDF-1.4\n")];
  const offsets = [0];
  let length = parts[0]!.length;
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const part = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      object,
      Buffer.from("\nendobj\n"),
    ]);
    parts.push(part);
    length += part.length;
  }
  parts.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
        .join(
          "",
        )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(parts);
}
function store(): BlobStore & { data: Map<string, Uint8Array> } {
  const data = new Map<string, Uint8Array>();
  return {
    data,
    async put(bytes) {
      const hash = createHash("sha256").update(bytes).digest("hex");
      data.set(hash, bytes.slice());
      return hash;
    },
    async get(hash) {
      const bytes = data.get(hash);
      if (!bytes) throw new Error("Missing blob");
      return bytes;
    },
  };
}

test("PDF text is sequential with 1-based page locators, including blank gaps", async () => {
  const blobs = store();
  const result = await capturePdf(
    fixture(["First page", "", "Third page"]),
    blobs,
  );
  assert.deepEqual(result.elements, [
    { id: "element_0", text: "First page ", locator: { kind: "page", page: 1 } },
    { id: "element_1", text: "Third page ", locator: { kind: "page", page: 3 } },
  ]);
  assert.deepEqual(result.images, []);
  assert.equal(blobs.data.size, 0);
});

test("PDF bitmap becomes a validated derived PNG with same-page links", async () => {
  const blobs = store();
  const result = await capturePdf(fixture(["A bitmap"], true), blobs);
  assert.equal(result.images.length, 1);
  const image = result.images[0]!;
  assert.equal(image.originKind, "decoded_embedded");
  assert.deepEqual(image.locator, { kind: "page", page: 1 });
  assert.deepEqual(image.elementIds, [result.elements[0]!.id]);
  validatePng(await blobs.get(image.blobHash));
  assert.match(PDF_CAPTURE_LIMITATIONS, /never original/);
});

test("invalid PDF fails without writing blobs", async () => {
  const blobs = store();
  await assert.rejects(
    capturePdf(Buffer.from("not a PDF"), blobs),
    /PDF parsing failed/,
  );
  assert.equal(blobs.data.size, 0);
});

test("empty/scanned PDFs reject explicitly without publishing images", async () => {
  for (const bitmap of [false, true]) {
    const blobs = store();
    await assert.rejects(
      capturePdf(fixture([""], bitmap), blobs),
      /no extractable text.*OCR/,
    );
    assert.equal(blobs.data.size, 0);
  }
});

test("input and page budgets reject", async () => {
  const blobs = store();
  await assert.rejects(capturePdf(new Uint8Array(), blobs), /PDF input/);
  await assert.rejects(
    capturePdf(new Uint8Array(20 * 1024 * 1024 + 1), blobs),
    /PDF input/,
  );
  await assert.rejects(
    capturePdf(fixture(Array.from({ length: 201 }, () => "page")), blobs),
    /page budget/,
  );
});

test("long PDF pages split into indexable elements and retain same-page image links", async () => {
  const result = await capturePdf(
    fixture(["x".repeat(40_000)], true, ".001"),
    store(),
  );
  assert.ok(result.elements.length > 40);
  assert.ok(result.elements.every((element) => element.text.length <= 1200));
  assert.ok(
    result.elements.reduce((sum, element) => sum + element.text.length, 0) >
      32_768,
  );
  assert.deepEqual(
    result.images[0]!.elementIds,
    result.elements.map((element) => element.id),
  );
  assert.ok(
    result.elements.every(
      (element) =>
        element.locator.kind === "page" && element.locator.page === 1,
    ),
  );
});

test('automatic windows preserve blank first window and boundary image page locators', async () => {
  const result = await capturePdf(fixture(['', '', '', '', '', 'Sixth', 'Seventh'], true), store());
  assert.deepEqual(result.elements.map(e => e.locator), [{ kind: 'page', page: 6 }, { kind: 'page', page: 7 }]);
  assert.equal(result.images.length, 7);
  for (const [i, image] of result.images.entries()) {
    assert.deepEqual(image.locator, { kind: 'page', page: i + 1 });
    assert.deepEqual(image.elementIds, result.elements.filter(e => e.locator.kind === 'page' && e.locator.page === i + 1).map(e => e.id));
  }
});

test('strict window metadata rejects missing, duplicate, reordered and inconsistent pages', () => {
  const pages = Array.from({ length: 5 }, (_, i) => ({ page: i + 1, text: '', images: [] }));
  const valid = { totalPages: 6, start: 1, end: 5, pages };
  const check = (value: unknown, start = 1, total: number | undefined = undefined) => validatePdfWindow(Buffer.from(JSON.stringify(value)), start, total, { text: 0, pixels: 0, images: 0 });
  assert.equal(check(valid).pages.length, 5);
  for (const value of [
    { ...valid, totalPages: 201 }, { ...valid, start: 2 }, { ...valid, end: 6 },
    { ...valid, pages: pages.slice(1) }, { ...valid, pages: [...pages, pages[4]] },
    { ...valid, pages: [...pages].reverse() }, { ...valid, pages: [pages[0], ...pages.slice(0, 4)] },
    { ...valid, extra: true },
  ]) assert.throws(() => check(value), /PDF/);
  assert.throws(() => check(valid, 1, 7), /metadata/);
  assert.throws(() => check({ totalPages: 6, start: 6, end: 6, pages: [pages[0]] }, 6, 6), /page/);
});

test('global budgets accumulate across valid windows rather than resetting', () => {
  const image = { width: 1, height: 1, channels: 3, data: 'AAAA' };
  const window = (start: number, text: string, images: unknown[]) => Buffer.from(JSON.stringify({
    totalPages: 6, start, end: start === 1 ? 5 : 6,
    pages: Array.from({ length: start === 1 ? 5 : 1 }, (_, i) => ({ page: start + i, text, images })),
  }));
  const budgets = { text: 0, pixels: 0, images: 95 };
  validatePdfWindow(window(1, '', [image]), 1, undefined, budgets);
  assert.equal(budgets.images, 100);
  assert.throws(() => validatePdfWindow(window(6, '', [image]), 6, 6, budgets), /image budget/);
  assert.throws(() => validatePdfWindow(window(6, 'xx', []), 6, 6, { text: 999999, pixels: 0, images: 0 }), /text budget/);
  assert.throws(() => validatePdfWindow(window(6, '', [image]), 6, 6, { text: 0, pixels: 8000000, images: 0 }), /image budget/);
});

test('PDF abort before and during worker extraction writes no blobs', async () => {
  for (const immediate of [true, false]) {
    const controller = new AbortController(), blobs = store();
    if (immediate) controller.abort();
    const timer = immediate ? undefined : setTimeout(() => controller.abort(), 30);
    try {
      await assert.rejects(capturePdf(fixture(Array.from({ length: 20 }, () => 'page'), true), blobs, { signal: controller.signal }), /abort/i);
      assert.equal(blobs.data.size, 0);
    } finally { clearTimeout(timer); }
  }
});

test('later-window global overflow rejects before any bitmap writes', async () => {
  const blobs = store();
  await assert.rejects(capturePdf(fixture(Array.from({ length: 101 }, () => 'page'), true), blobs), /image budget/);
  assert.equal(blobs.data.size, 0);
  await assert.rejects(capturePdf(fixture(Array.from({ length: 11 }, () => 'x'.repeat(95000)), true, '.0001'), blobs), /text budget/);
  assert.equal(blobs.data.size, 0);
});

test('real multi-window runtime retains one exact source/revision and reopens physical locators', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { KnowledgeRuntime } = await import('../src/application/knowledge-runtime.ts');
  const { SqliteCatalog } = await import('../src/adapters/storage/sqlite-catalog.ts');
  const root = await mkdtemp(join(tmpdir(), 'studio-auto-pdf-'));
  try {
    const bytes = fixture(Array.from({ length: 12 }, (_, i) => `Physical page ${i + 1}`), true);
    const path = join(root, 'one.pdf');
    await writeFile(path, bytes);
    const runtime = new KnowledgeRuntime(join(root, 'collection'));
    const document = await runtime.ingest(root, path);
    assert.equal(document.parserVersion, 'local-native-pdf-window5-chunk800-v3');
    assert.equal(document.sourceHash, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(Buffer.from(await runtime.blobs.get(document.sourceHash)), bytes);
    const reopened = new KnowledgeRuntime(runtime.root);
    const snapshot = await SqliteCatalog.use(reopened.root, async c => c.snapshot());
    assert.equal(snapshot.documents.length, 1);
    assert.deepEqual(snapshot.documents[0], document);
    assert.deepEqual(document.elements.map(e => e.locator), Array.from({ length: 12 }, (_, i) => ({ kind: 'page', page: i + 1 })));
    assert.equal(document.images.length, 12);
    assert.ok((await reopened.search('Physical')).hits.length > 0);
    const { captureLocal } = await import('../src/adapters/parsing/capture-local.ts');
    const controller = new AbortController(), blobs = store();
    const timer = setTimeout(() => controller.abort(), 25);
    try {
      await assert.rejects(captureLocal(root, path, blobs, undefined, { signal: controller.signal }), /abort/i);
      assert.equal(blobs.data.size, 0);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    } finally { clearTimeout(timer); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('capture refuses late persistence success without claiming rollback of blobs', async (t) => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { captureLocal } = await import('../src/adapters/parsing/capture-local.ts');
  const root = await mkdtemp(join(tmpdir(), 'studio-late-capture-'));
  const path = join(root, 'one.pdf');
  const blobs = store();
  try {
    await writeFile(path, fixture(['Deadline check'], true));
    const now = Date.now();
    const lateStore: BlobStore = {
      get: hash => blobs.get(hash),
      async put(bytes) {
        const hash = await blobs.put(bytes);
        t.mock.method(Date, 'now', () => now + 180_000);
        return hash;
      },
    };
    await assert.rejects(captureLocal(root, path, lateStore), /deadline exceeded/);
    assert.equal(blobs.data.size, 1, 'completed CAS write remains, but capture cannot succeed late');
  } finally {
    t.mock.restoreAll();
    await rm(root, { recursive: true, force: true });
  }
});

test('worker protocol rejects malformed UTF-8, JSON, text and bitmap encodings', () => {
  const check = (buffer: Buffer) => validatePdfWindow(buffer, 1, undefined, { text: 0, pixels: 0, images: 0 });
  for (const bytes of [Buffer.from([0xff]), Buffer.from('{'), Buffer.alloc(48 * 1024 * 1024 + 1)])
    assert.throws(() => check(bytes), /PDF/);
  for (const page of [
    { page: 1, text: '\0', images: [] },
    { page: 1, text: 'x'.repeat(100001), images: [] },
    { page: 1, text: '', images: [{ width: 1, height: 1, channels: 3, data: '!!!!' }] },
    { page: 1, text: '', images: [{ width: 1, height: 1, channels: 2, data: 'AAAA' }] },
  ]) assert.throws(() => check(Buffer.from(JSON.stringify({ totalPages: 1, start: 1, end: 1, pages: [page] }))), /PDF/);
});

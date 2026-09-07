import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeRuntime } from "../src/application/knowledge-runtime.ts";
import {
  captureDocx,
  DOCX_CAPTURE_LIMITATIONS,
} from "../src/adapters/parsing/capture-docx.ts";
import { encodePng } from "../src/adapters/export/encode-png.ts";
import type { BlobStore } from "../src/ports/blob-store.ts";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const png = encodePng(1, 1, 3, new Uint8Array([12, 34, 56]));
const picture = `<w:drawing><wp:inline><wp:docPr id="1" name="image" descr="Original diagram"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="im1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
function document(body: string): string {
  return `<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}</w:body></w:document>`;
}
function parts(body: string): Record<string, string | Uint8Array> {
  return {
    "[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": document(body),
    "word/_rels/document.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="im1" Type="${R}/image" Target="media/image.png"/></Relationships>`,
    "word/media/image.png": png,
  };
}
function zip(
  entries: Record<string, string | Uint8Array>,
  mode = "normal",
): Buffer {
  const payload = Object.entries(entries).map(([key, value]) => [
    key,
    Buffer.from(value).toString("base64"),
  ]);
  const result = spawnSync(
    "python3",
    [
      "-I",
      "-B",
      "-c",
      `
import sys,json,zipfile,io,base64
entries=json.load(sys.stdin)
b=io.BytesIO()
with zipfile.ZipFile(b,'w',compression=zipfile.ZIP_DEFLATED) as z:
 for path,data in entries:
  i=zipfile.ZipInfo(path)
  i.compress_type=zipfile.ZIP_DEFLATED
  if sys.argv[1]=='symlink' and path=='word/media/image.png': i.external_attr=(0o120777 << 16)
  z.writestr(i,base64.b64decode(data))
 if sys.argv[1]=='duplicate': z.writestr(entries[0][0],b'duplicate')
sys.stdout.buffer.write(b.getvalue())
`,
      mode,
    ],
    { input: JSON.stringify(payload), maxBuffer: 30 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
}
function store(): BlobStore & {
  data: Map<string, Uint8Array>;
  writes: number;
} {
  const data = new Map<string, Uint8Array>();
  return {
    data,
    writes: 0,
    async put(bytes) {
      this.writes++;
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

test("DOCX ignores internal JPEG package thumbnails without capturing them", async () => {
  const entries = parts(`<w:p><w:r><w:t>Scheduler</w:t>${picture}</w:r></w:p>`);
  entries["_rels/.rels"] = String(entries["_rels/.rels"]).replace(
    "</Relationships>",
    '<Relationship Id="preview" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="docProps/thumbnail.jpeg"/></Relationships>',
  );
  entries["docProps/thumbnail.jpeg"] = Buffer.from([255, 216, 255, 217]);
  const blobs = store();
  const result = await captureDocx(zip(entries), blobs);
  assert.equal(result.elements[0]?.text, "Scheduler");
  assert.equal(result.images.length, 1);
  assert.equal(blobs.writes, 1);
  assert.deepEqual(
    Buffer.from(await blobs.get(result.images[0]!.blobHash)),
    png,
  );
});

test("DOCX ordered paragraphs/table text, literal whitespace and namespace aliases", async () => {
  const entries = parts(
    `<w:p><w:r><w:t xml:space="preserve"> 001 &amp; </w:t><w:tab/><w:t>text</w:t><w:br/><w:cr/></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`,
  );
  entries["word/document.xml"] = String(entries["word/document.xml"])
    .replaceAll("w:", "q:")
    .replace("xmlns:w=", "xmlns:q=");
  const result = await captureDocx(zip(entries), store());
  assert.deepEqual(
    result.elements.map((e) => e.text),
    [" 001 & \ttext\n\n", "cell"],
  );
  assert.deepEqual(result.elements[1]!.locator, {
    kind: "anchor",
    anchor: "word/document.xml#p=2",
  });
  assert.match(DOCX_CAPTURE_LIMITATIONS, /Restricted DOCX/);
});

test("DOCX repeated original PNG occurrences retain bytes and paragraph-only links", async () => {
  const bytes = zip(
    parts(
      `<w:p><w:r><w:t>diagram</w:t>${picture}${picture}</w:r></w:p><w:p><w:r>${picture}</w:r></w:p>`,
    ),
  );
  const blobs = store();
  const result = await captureDocx(bytes, blobs);
  assert.equal(result.images.length, 3);
  assert.equal(new Set(result.images.map((i) => i.id)).size, 3);
  assert.equal(
    new Set(result.images.map((i) => JSON.stringify(i.locator))).size,
    3,
  );
  assert.equal(new Set(result.images.map((i) => i.blobHash)).size, 1);
  assert.deepEqual(
    result.images.map((i) => i.elementIds),
    [["element_0"], ["element_0"], []],
  );
  assert.ok(result.images.every((i) => i.originKind === "embedded_original"));
  assert.deepEqual(
    Buffer.from(await blobs.get(result.images[0]!.blobHash)),
    Buffer.from(png),
  );
  assert.equal(blobs.writes, 1);
  assert.deepEqual(await captureDocx(bytes, store()), result);
});

test("DOCX long Unicode paragraph splits <=30000 UTF-16 units without breaking pairs", async () => {
  const content = "x".repeat(29999) + "😀".repeat(18000);
  const result = await captureDocx(
    zip(parts(`<w:p><w:r><w:t>${content}</w:t>${picture}</w:r></w:p>`)),
    store(),
  );
  assert.equal(result.elements.map((e) => e.text).join(""), content);
  assert.ok(
    result.elements.every(
      (e) => e.text.length <= 30000 && !/[\uD800-\uDFFF]/u.test(e.text),
    ),
  );
  assert.deepEqual(
    result.images[0]!.elementIds,
    result.elements.map((e) => e.id),
  );
});

test("DOCX unsafe ZIPs, relationships, XML and unsupported content reject before writes", async () => {
  const good = `<w:p><w:r><w:t>safe</w:t>${picture}</w:r></w:p>`;
  const cases: Array<[Record<string, string | Uint8Array>, string?]> = [];
  for (const path of [
    "../escape",
    "/absolute",
    "word\\evil",
    "word/./evil",
    "C:evil",
    "word/%2e%2e/evil",
    "WORD/document.xml",
  ]) {
    cases.push([{ ...parts(good), [path]: "evil" }]);
  }
  cases.push([parts(good), "duplicate"], [parts(good), "symlink"]);
  for (const target of [
    "https://invalid/image.png",
    "../media/image.png",
    "media/%69mage.png",
    "media/image.png?x",
    "//host/image.png",
    "media/missing.png",
  ]) {
    const entries = parts(good);
    entries["word/_rels/document.xml.rels"] = String(
      entries["word/_rels/document.xml.rels"],
    ).replace("media/image.png", target);
    cases.push([entries]);
  }
  for (const xml of [
    `<!DOCTYPE w:document [<!ENTITY x SYSTEM "file:///etc/passwd">]>${document(good)}`,
    document(good).replace(W, "urn:spoof"),
    document(`<w:p>${"<w:r>".repeat(65)}${"</w:r>".repeat(65)}</w:p>`),
    document(`<w:p bad="${"x".repeat(33000)}"/>`),
    document(
      `<w:p><w:r>${picture.replace('r:embed="im1"', 'r:link="im1"')}</w:r></w:p>`,
    ),
    ...["pict", "object", "altChunk", "ins", "txbxContent", "fldSimple"].map(
      (tag) => document(`<w:p><w:${tag}/></w:p>`),
    ),
  ])
    cases.push([{ ...parts(good), "word/document.xml": xml }]);
  cases.push([
    { ...parts(good), "word/document.xml": new Uint8Array([255, 254]) },
  ]);
  for (const [entries, mode] of cases) {
    const blobs = store();
    await assert.rejects(captureDocx(zip(entries, mode), blobs));
    assert.equal(blobs.writes, 0);
  }
});

test("DOCX validates every image before writing even an earlier valid image", async () => {
  const entries = parts(
    `<w:p><w:r>${picture}${picture.replace("im1", "im2")}</w:r></w:p>`,
  );
  entries["word/_rels/document.xml.rels"] = String(
    entries["word/_rels/document.xml.rels"],
  ).replace(
    "</Relationships>",
    `<Relationship Id="im2" Type="${R}/image" Target="media/bad.png"/></Relationships>`,
  );
  entries["word/media/bad.png"] = "not PNG";
  const blobs = store();
  await assert.rejects(captureDocx(zip(entries), blobs), /PNG/);
  assert.equal(blobs.writes, 0);
});

test("DOCX input, occurrence, XML and aggregate text budgets reject", async () => {
  const blobs = store();
  for (const bytes of [
    new Uint8Array(),
    new Uint8Array(20 * 1024 * 1024 + 1),
    Buffer.from("not ZIP"),
    zip(parts(`<w:p><w:r>${picture.repeat(101)}</w:r></w:p>`)),
    zip(parts(`<w:p><w:r><w:t>${"x".repeat(1_000_001)}</w:t></w:r></w:p>`)),
    zip({ ...parts(""), "ignored.xml": "x".repeat(4 * 1024 * 1024 + 1) }),
  ])
    await assert.rejects(captureDocx(bytes, blobs));
  assert.equal(blobs.writes, 0);
});

test("DOCX runtime reopens, retrieves repeated occurrences and exports movable original assets offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-docx-"));
  try {
    const source = join(root, "source"),
      data = join(root, "data"),
      output = join(root, "output");
    await mkdir(source);
    await mkdir(output);
    const path = join(source, "guide.docx");
    await writeFile(
      path,
      zip(
        parts(
          `<w:p><w:r><w:t>quartz diagram</w:t>${picture}${picture}</w:r></w:p>`,
        ),
      ),
    );
    const original = await new KnowledgeRuntime(data).ingest(source, path);
    const reopened = new KnowledgeRuntime(data);
    const result = await reopened.search("quartz");
    assert.equal(result.bundle.images.length, 2);
    const exported = await reopened.export("quartz", output, {
      documentContent: true,
      images: true,
      excerpts: true,
    });
    const moved = join(root, "moved");
    await rename(exported, moved);
    await rm(source, { recursive: true });
    await rm(data, { recursive: true });
    assert.deepEqual(
      await readFile(
        join(moved, "assets", `${original.images[0]!.blobHash}.png`),
      ),
      Buffer.from(png),
    );
    assert.match(
      await readFile(join(moved, "document.html"), "utf8"),
      /quartz/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DOCX local/central mismatch, CRC corruption and encryption reject", async () => {
  const original = zip(parts(`<w:p><w:r><w:t>safe</w:t></w:r></w:p>`));
  const mutations = [
    (b: Buffer) => b.writeUInt32LE(b.readUInt32LE(22) + 1, 22),
    (b: Buffer) => {
      b[30 + b.readUInt16LE(26)]! ^= 0xff;
    },
    (b: Buffer) => {
      b.writeUInt16LE(1, 6);
      b.writeUInt16LE(1, b.indexOf(Buffer.from("504b0102", "hex")) + 8);
    },
    (b: Buffer) => {
      b[30]! ^= 1;
    },
  ];
  for (const mutate of mutations) {
    const bytes = Buffer.from(original);
    mutate(bytes);
    const blobs = store();
    await assert.rejects(captureDocx(bytes, blobs));
    assert.equal(blobs.writes, 0);
  }
});

test("DOCX original and combined image budgets are independent in both asset orders", {
  timeout: 120_000,
}, async (t) => {
  const { default: sharp } = await import("sharp");
  const MiB = 1024 * 1024;
  const width = 1800,
    height = 1800;
  const originals: Buffer[] = [];
  // Fixed-seed noise prevents tiny compressed fixtures from missing the budget
  // boundary. Generate sequentially; retain only the compressed originals.
  for (const seed of [0x12345678, 0x87654321]) {
    const pixels = Buffer.alloc(width * height * 3);
    let state = seed;
    for (let i = 0; i < pixels.length; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      pixels[i] = state & 0xff;
    }
    originals.push(
      await sharp(pixels, { raw: { width, height, channels: 3 } })
        .jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
        .toBuffer(),
    );
  }
  const originalBytes = originals.reduce((sum, bytes) => sum + bytes.length, 0);
  assert.ok(originalBytes < 20 * MiB, `original bytes: ${originalBytes}`);

  for (const order of [
    [0, 1],
    [1, 0],
  ]) {
    // Change both ZIP insertion and first-occurrence order (the worker emits
    // assets in first-occurrence order), not merely the relationship IDs.
    const entries = parts(
      `<w:p><w:r><w:t>budget regression</w:t>${order.map((index) => picture.replace('r:embed="im1"', `r:embed="im${index + 1}"`)).join("")}</w:r></w:p>`,
    );
    entries["[Content_Types].xml"] = String(
      entries["[Content_Types].xml"],
    ).replace(
      'Extension="png" ContentType="image/png"',
      'Extension="jpeg" ContentType="image/jpeg"',
    );
    entries["word/_rels/document.xml.rels"] =
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${order.map((index) => `<Relationship Id="im${index + 1}" Type="${R}/image" Target="media/noise${index}.jpeg"/>`).join("")}</Relationships>`;
    delete entries["word/media/image.png"];
    for (const index of order)
      entries[`word/media/noise${index}.jpeg`] = originals[index]!;
    const bytes = zip(entries);
    assert.ok(bytes.length < 20 * MiB, `DOCX bytes: ${bytes.length}`);
    const blobs = store();
    const result = await captureDocx(bytes, blobs);
    assert.equal(result.images.length, 2);
    assert.equal(blobs.writes, 4);
    let combinedBytes = originalBytes,
      renditionPixels = 0;
    for (const [position, image] of result.images.entries()) {
      assert.deepEqual(
        Buffer.from(await blobs.get(image.blobHash)),
        originals[order[position]!]!,
      );
      assert.equal(image.originKind, "embedded_original");
      assert.deepEqual(image.elementIds, ["element_0"]);
      assert.ok(image.rendition);
      assert.equal(image.rendition.sourceMediaType, "image/jpeg");
      assert.equal(image.rendition.mediaType, "image/png");
      assert.equal(image.rendition.width, width);
      assert.equal(image.rendition.height, height);
      const display = await blobs.get(image.rendition.blobHash);
      assert.deepEqual(
        Buffer.from(display.subarray(0, 8)),
        Buffer.from("89504e470d0a1a0a", "hex"),
      );
      combinedBytes += display.length;
      renditionPixels += image.rendition.width * image.rendition.height;
      // The old shared counter rejected the second original after counting
      // the first rendition against the original-only 20 MiB limit.
      if (position === 0) assert.ok(originalBytes + display.length > 20 * MiB);
    }
    assert.ok(
      combinedBytes > 20 * MiB && combinedBytes < 50 * MiB,
      `combined bytes: ${combinedBytes}`,
    );
    assert.ok(renditionPixels <= 16_000_000);
    t.diagnostic(
      `order=${order.join(",")}: originals=${originalBytes}, combined=${combinedBytes}, pixels=${renditionPixels}`,
    );
    blobs.data.clear();
  }
});

for (const format of ["jpeg", "webp"] as const) {
  test(`DOCX ${format} repeated originals retain rendition links; invalid later asset writes nothing`, async () => {
    const { default: sharp } = await import("sharp");
    const original = await sharp({
      create: { width: 2, height: 3, channels: 3, background: "blue" },
    })
      [format]()
      .toBuffer();
    const entries = parts(
      `<w:p><w:r><w:t>diagram</w:t>${picture}${picture}</w:r></w:p>`,
    );
    entries["[Content_Types].xml"] = String(
      entries["[Content_Types].xml"],
    ).replaceAll("png", format);
    entries["word/_rels/document.xml.rels"] = String(
      entries["word/_rels/document.xml.rels"],
    ).replace("image.png", `image.${format}`);
    delete entries["word/media/image.png"];
    entries[`word/media/image.${format}`] = original;
    const blobs = store();
    const result = await captureDocx(zip(entries), blobs);
    assert.equal(result.images.length, 2);
    assert.deepEqual(
      result.images.map((i) => i.elementIds),
      [["element_0"], ["element_0"]],
    );
    for (const image of result.images) {
      assert.deepEqual(Buffer.from(await blobs.get(image.blobHash)), original);
      assert.equal(image.rendition?.sourceMediaType, `image/${format}`);
      assert.ok(blobs.data.has(image.rendition!.blobHash));
    }
    entries["word/document.xml"] = String(entries["word/document.xml"]).replace(
      "</w:body>",
      `<w:p><w:r>${picture.replace('r:embed="im1"', 'r:embed="bad"')}</w:r></w:p></w:body>`,
    );
    entries["word/_rels/document.xml.rels"] = String(
      entries["word/_rels/document.xml.rels"],
    ).replace(
      "</Relationships>",
      `<Relationship Id="bad" Type="${R}/image" Target="media/bad.${format}"/></Relationships>`,
    );
    entries[`word/media/bad.${format}`] = Buffer.from("invalid");
    const denied = store();
    await assert.rejects(captureDocx(zip(entries), denied));
    assert.equal(denied.writes, 0);
  });
}

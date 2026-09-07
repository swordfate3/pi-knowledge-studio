import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import test from "node:test";
import type {
  EvidenceBundle,
  IllustratedDocument,
} from "../src/domain/evidence.ts";
import { FileBlobStore, sha256 } from "../src/adapters/blob/file-blob-store.ts";
import { exportPortableDocument } from "../src/adapters/export/portable-export.ts";
import { validatePng } from "../src/adapters/export/png.ts";

// A synthetic 1x1 RGB PNG, not a book image or private document.
function png(
  dataType = "IDAT",
  extra = Buffer.alloc(0),
  ancillary = "",
): Buffer {
  function chunk(type: string, data: Buffer): Buffer {
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length);
    result.write(type, 4, "latin1");
    data.copy(result, 8);
    let crc = 0xffffffff;
    for (const byte of result.subarray(4, result.length - 4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    ...(ancillary ? [chunk(ancillary, Buffer.alloc(0))] : []),
    chunk(
      dataType,
      Buffer.concat([deflateSync(Buffer.from([0, 255, 0, 0])), extra]),
    ),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "studio-v2-test-"));
  const output = join(root, "output");
  await mkdir(output);
  const store = new FileBlobStore(join(root, "blobs"));
  const bytes = png();
  const blobHash = await store.put(bytes);
  const excerpt = "任务调度原文";
  const bundle: EvidenceBundle = {
    schemaVersion: 1,
    id: "bundle1",
    snapshotId: "snapshot1",
    sources: [
      {
        id: "source1",
        label: "Synthetic guide",
        revisionHash: sha256("synthetic source"),
      },
    ],
    texts: [
      {
        id: "text1",
        sourceId: "source1",
        elementId: "element1",
        locator: { kind: "lines", start: 1, end: 1 },
        text: excerpt,
        textHash: sha256(excerpt),
        start: 0,
        end: excerpt.length,
      },
    ],
    images: [
      {
        id: "image1",
        sourceId: "source1",
        locator: { kind: "page", page: 1 },
        blobHash,
        originKind: "embedded_original",
      },
      {
        id: "image2",
        sourceId: "source1",
        locator: { kind: "page", page: 2 },
        blobHash,
        originKind: "page_crop",
      },
    ],
  };
  const document: IllustratedDocument = {
    title: "调度资料",
    bundleId: bundle.id,
    mode: "evidence-compilation",
    blocks: [
      { kind: "paragraph", text: "调度说明", evidenceIds: ["text1"] },
      {
        kind: "figure",
        occurrenceId: "image1",
        caption: "Original",
        evidenceIds: ["text1"],
      },
      {
        kind: "figure",
        occurrenceId: "image2",
        caption: "Crop",
        evidenceIds: ["text1"],
      },
    ],
  };
  return { root, output, store, bytes, blobHash, bundle, document };
}

const permission = { documentContent: true, images: true, excerpts: true };

test("portable package retains exact bytes, separate occurrences and offline excerpts", async () => {
  const f = await fixture();
  try {
    const result = await exportPortableDocument(
      f.output,
      f.bundle,
      f.document,
      permission,
      f.store,
    );
    const moved = join(f.root, "moved");
    await rename(result, moved);
    await rm(f.store.root, { recursive: true });
    assert.deepEqual(
      await readFile(join(moved, "assets", `${f.blobHash}.png`)),
      f.bytes,
    );
    assert.equal((await readdir(join(moved, "assets"))).length, 1);
    const sources = JSON.parse(
      await readFile(join(moved, "sources.json"), "utf8"),
    );
    assert.equal(sources.occurrences.length, 2);
    assert.equal(sources.occurrences[1].originKind, "page_crop");
    assert.equal(sources.occurrences[1].locator.page, 2);
    const evidence = JSON.parse(
      await readFile(join(moved, "evidence.json"), "utf8"),
    );
    assert.equal(evidence.excerpts[0].text, f.bundle.texts[0]!.text);
    const html = await readFile(join(moved, "document.html"), "utf8");
    assert.ok(!html.includes(f.root));
    assert.ok(html.includes("Content-Security-Policy"));
    for (const match of html.matchAll(/src="([^"]+)"/g))
      await readFile(join(moved, match[1]!));
    const manifest = JSON.parse(
      await readFile(join(moved, "manifest.json"), "utf8"),
    );
    for (const item of manifest.files)
      assert.equal(sha256(await readFile(join(moved, item.path))), item.sha256);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("CAS deduplicates concurrent writers and rejects corrupted bytes and path identifiers", async () => {
  const f = await fixture();
  try {
    const hashes = await Promise.all(
      Array.from({ length: 8 }, () => f.store.put(f.bytes)),
    );
    assert.equal(new Set(hashes).size, 1);
    assert.deepEqual(await readdir(f.store.root), [f.blobHash]);
    await assert.rejects(f.store.get("../secret"), /Invalid SHA/);
    await writeFile(join(f.store.root, f.blobHash), "corrupt");
    await assert.rejects(f.store.get(f.blobHash), /integrity/);
    await assert.rejects(f.store.put(f.bytes), /integrity/);
    await assert.rejects(
      exportPortableDocument(
        f.output,
        f.bundle,
        f.document,
        permission,
        f.store,
      ),
      /integrity/,
    );
    assert.deepEqual(await readdir(f.output), []);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("unknown references, altered excerpts and missing image permission fail before publication", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      exportPortableDocument(
        f.output,
        f.bundle,
        f.document,
        { ...permission, images: false },
        f.store,
      ),
      /not approved/,
    );
    const foreign = structuredClone(f.document);
    foreign.blocks[0]!.evidenceIds = ["invented"];
    await assert.rejects(
      exportPortableDocument(f.output, f.bundle, foreign, permission, f.store),
      /Unknown text/,
    );
    const changed = structuredClone(f.bundle);
    changed.texts[0]!.text = "替换文字不可信";
    changed.texts[0]!.end = changed.texts[0]!.text.length;
    await assert.rejects(
      exportPortableDocument(
        f.output,
        changed,
        f.document,
        permission,
        f.store,
      ),
      /integrity/,
    );
    assert.deepEqual(await readdir(f.output), []);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("provenance-only omits excerpts and unrelated sources, and escapes hostile content", async () => {
  const f = await fixture();
  try {
    f.document.title = '<script>alert("x")</script>';
    f.document.blocks[0] = {
      kind: "paragraph",
      text: "![attack](https://evil.invalid/x)\n<img src=x onerror=alert(1)>",
      evidenceIds: ["text1"],
    };
    f.bundle.sources.push({
      id: "unused",
      label: "UNSHARED_SOURCE",
      revisionHash: sha256("unused"),
    });
    const result = await exportPortableDocument(
      f.output,
      f.bundle,
      f.document,
      { ...permission, excerpts: false },
      f.store,
    );
    const html = await readFile(join(result, "document.html"), "utf8");
    const md = await readFile(join(result, "document.md"), "utf8");
    const evidence = await readFile(join(result, "evidence.json"), "utf8");
    assert.ok(html.includes("provenance-only"));
    assert.ok(!html.includes("<script>"));
    assert.ok(!html.includes("<img src=x"));
    assert.ok(!md.includes("![attack]"));
    assert.ok(!md.includes("https://evil"));
    assert.ok(!evidence.includes(f.bundle.texts[0]!.text));
    assert.ok(!html.includes(f.bundle.texts[0]!.text));
    assert.ok(
      !(await readFile(join(result, "sources.json"), "utf8")).includes(
        "UNSHARED_SOURCE",
      ),
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("symlinked output roots and blob leaves are rejected", async () => {
  const f = await fixture();
  try {
    const alias = join(f.root, "alias");
    await symlink(f.output, alias, "dir");
    await assert.rejects(
      exportPortableDocument(alias, f.bundle, f.document, permission, f.store),
    );
    await rm(join(f.store.root, f.blobHash));
    const outside = join(f.root, "outside.png");
    await writeFile(outside, f.bytes);
    await symlink(outside, join(f.store.root, f.blobHash));
    await assert.rejects(f.store.get(f.blobHash));
    assert.deepEqual(await readdir(f.output), []);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("export freezes inputs across async blob reads and rechecks untrusted blob providers", async () => {
  const f = await fixture();
  try {
    let reads = 0;
    const mutatingStore = {
      put: f.store.put.bind(f.store),
      get: async (id: string) => {
        reads++;
        f.document.title = "MUTATED_AFTER_START";
        f.bundle.texts[0]!.text = "MUTATED_EXCERPT";
        return f.store.get(id);
      },
    };
    const result = await exportPortableDocument(
      f.output,
      f.bundle,
      f.document,
      permission,
      mutatingStore,
    );
    assert.equal(reads, 1);
    assert.ok(
      !(await readFile(join(result, "document.html"), "utf8")).includes(
        "MUTATED",
      ),
    );
    const second = await fixture();
    try {
      await assert.rejects(
        exportPortableDocument(
          second.output,
          second.bundle,
          second.document,
          permission,
          {
            put: second.store.put.bind(second.store),
            get: async () => Buffer.from("wrong bytes"),
          },
        ),
        /integrity/,
      );
    } finally {
      await rm(second.root, { recursive: true, force: true });
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("PNG gate rejects SVG, damaged CRC, truncation and trailing content", () => {
  validatePng(png());
  assert.throws(() => validatePng(png("\u00c9DAT")), /chunk name/);
  assert.throws(
    () => validatePng(png("IDAT", Buffer.alloc(0), "abca")),
    /chunk name/,
  );
  assert.throws(
    () => validatePng(png("IDAT", Buffer.from("hidden"))),
    /Trailing PNG/,
  );
  assert.throws(
    () => validatePng(png("IDAT", deflateSync(Buffer.from([0, 0, 0, 0])))),
    /Trailing PNG/,
  );
  assert.throws(
    () => validatePng(Buffer.from('<svg onload="alert(1)"/>')),
    /expected PNG/,
  );
  const bad = png();
  bad[30] = bad[30]! ^ 1;
  assert.throws(() => validatePng(bad), /CRC/);
  assert.throws(() => validatePng(png().subarray(0, 20)), /Truncated/);
  assert.throws(
    () => validatePng(Buffer.concat([png(), Buffer.from("payload")])),
    /ending/,
  );
});

test("document approval is independent of supplementary excerpt permission", async () => {
  const f = await fixture();
  try {
    const excerpt = f.bundle.texts[0]!.text;
    f.document.title = excerpt;
    f.document.blocks[0] = {
      kind: "paragraph",
      text: excerpt,
      evidenceIds: ["text1"],
    };
    f.document.blocks[1] = {
      kind: "figure",
      occurrenceId: "image1",
      caption: excerpt,
      evidenceIds: [],
    };
    await assert.rejects(
      exportPortableDocument(
        f.output,
        f.bundle,
        f.document,
        { ...permission, documentContent: false, excerpts: false },
        f.store,
      ),
      /Document content/,
    );
    const result = await exportPortableDocument(
      f.output,
      f.bundle,
      f.document,
      { ...permission, excerpts: false },
      f.store,
    );
    assert.ok(
      (await readFile(join(result, "document.html"), "utf8")).includes(excerpt),
    );
    assert.ok(
      !(await readFile(join(result, "evidence.json"), "utf8")).includes(
        excerpt,
      ),
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("image-only evidence exports without invented text citations", async () => {
  const f = await fixture();
  try {
    f.bundle.texts = [];
    f.document.blocks = [
      {
        kind: "figure",
        occurrenceId: "image1",
        caption: "Only an image",
        evidenceIds: [],
      },
    ];
    const result = await exportPortableDocument(
      f.output,
      f.bundle,
      f.document,
      permission,
      f.store,
    );
    assert.ok(
      (await readFile(join(result, "document.html"), "utf8")).includes(
        "Only an image",
      ),
    );
    assert.equal(
      JSON.parse(await readFile(join(result, "sources.json"), "utf8")).sources
        .length,
      1,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("group-writable output and blob roots fail closed on POSIX", {
  skip: process.platform === "win32",
}, async () => {
  const f = await fixture();
  try {
    await chmod(f.output, 0o777);
    await assert.rejects(
      exportPortableDocument(
        f.output,
        f.bundle,
        f.document,
        permission,
        f.store,
      ),
      /not writable/,
    );
    await chmod(f.store.root, 0o777);
    await assert.rejects(f.store.put(f.bytes), /not writable/);
    assert.deepEqual(await readdir(f.output), []);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

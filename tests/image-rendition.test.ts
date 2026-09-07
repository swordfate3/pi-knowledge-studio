import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  rename,
  copyFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  prepareImage,
  verifiedDisplay,
} from "../src/adapters/parsing/capture-image.ts";
import { captureLocal } from "../src/adapters/parsing/capture-local.ts";
import { FileBlobStore, sha256 } from "../src/adapters/blob/file-blob-store.ts";
import { exportPortableDocument } from "../src/adapters/export/portable-export.ts";
import { encodePng } from "../src/adapters/export/encode-png.ts";
import { validatePng } from "../src/adapters/export/png.ts";
import type {
  EvidenceBundle,
  IllustratedDocument,
} from "../src/domain/evidence.ts";

// Synthetic real-codec fixtures; no network or private source input.
async function fixture(format: "jpeg" | "webp") {
  return sharp({
    create: {
      width: 3,
      height: 2,
      channels: 4,
      background: { r: 20, g: 90, b: 180, alpha: 0.5 },
    },
  })
    [format]()
    .toBuffer();
}
for (const format of ["jpeg", "webp"] as const) {
  test(`${format}: exact originals, repeated MD associations and moved offline export of both assets`, async () => {
    const root = await mkdtemp(join(tmpdir(), "rendition-"));
    try {
      const bytes = await fixture(format),
        path = join(root, `image.${format}`);
      await writeFile(path, bytes);
      const blobs = new FileBlobStore(join(root, "cas"));
      const standalone = await captureLocal(root, path, blobs);
      const image = standalone.images[0]!;
      assert.equal(image.blobHash, sha256(bytes));
      assert.equal(image.rendition?.sourceMediaType, `image/${format}`);
      assert.deepEqual(Buffer.from(await blobs.get(image.blobHash)), bytes);
      validatePng(await blobs.get(image.rendition!.blobHash));
      await writeFile(
        join(root, "input.md"),
        `hello ![first](image.${format}) ![second](image.${format})`,
      );
      const captured = await captureLocal(root, join(root, "input.md"), blobs);
      assert.equal(captured.images.length, 2);
      assert.deepEqual(
        captured.images.map((i) => i.elementIds),
        [["element_0"], ["element_0"]],
      );
      const bundle: EvidenceBundle = {
        schemaVersion: 1,
        id: "bundle",
        snapshotId: "snapshot",
        sources: [
          { id: "source", label: "synthetic", revisionHash: captured.revision },
        ],
        texts: [],
        images: captured.images.map((i) => ({
          id: i.id,
          sourceId: "source",
          blobHash: i.blobHash,
          rendition: i.rendition!,
          locator: i.locator,
          originKind: i.originKind,
        })),
      };
      const document: IllustratedDocument = {
        title: "originals",
        bundleId: bundle.id,
        mode: "evidence-compilation",
        blocks: bundle.images.map((i) => ({
          kind: "figure",
          occurrenceId: i.id,
          caption: "synthetic",
          evidenceIds: [],
        })),
      };
      await mkdir(join(root, "out"));
      const output = await exportPortableDocument(
        join(root, "out"),
        bundle,
        document,
        { documentContent: true, images: true, excerpts: false },
        blobs,
      );
      const moved = join(root, "moved");
      await rename(output, moved);
      await rm(join(root, "cas"), { recursive: true });
      const originalPath = `assets/${image.blobHash}.${format === "jpeg" ? "jpg" : "webp"}`,
        displayPath = `assets/${image.rendition!.blobHash}.png`;
      assert.deepEqual(await readFile(join(moved, originalPath)), bytes);
      assert.equal(
        sha256(await readFile(join(moved, displayPath))),
        image.rendition!.blobHash,
      );
      for (const name of ["document.html", "document.md"]) {
        const content = await readFile(join(moved, name), "utf8");
        assert.ok(content.includes(displayPath));
        assert.ok(!content.includes(originalPath));
      }
      const sources = JSON.parse(
        await readFile(join(moved, "sources.json"), "utf8"),
      );
      assert.equal(sources.occurrences.length, 2);
      assert.equal(
        sources.occurrences[0].rendition.blobHash,
        image.rendition!.blobHash,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("decoder rejects truncation, appended data, bad format, animation and excessive dimensions", async () => {
  for (const format of ["jpeg", "webp"] as const) {
    const bytes = await fixture(format);
    await assert.rejects(prepareImage(bytes.subarray(0, bytes.length - 4)));
    await assert.rejects(
      prepareImage(Buffer.concat([bytes, Buffer.from("tail")])),
    );
    await assert.rejects(prepareImage(bytes, ".png"), /mismatch/);
  }
  await assert.rejects(prepareImage(Buffer.from("not an image")), /format/);
  const animated = Buffer.alloc(30);
  animated.write("RIFF");
  animated.writeUInt32LE(22, 4);
  animated.write("WEBPVP8X", 8);
  animated.writeUInt32LE(10, 16);
  animated[20] = 2;
  await assert.rejects(prepareImage(animated), /Animated/);
  const huge = await sharp({
    create: { width: 2001, height: 2000, channels: 3, background: "red" },
  })
    .jpeg()
    .toBuffer();
  await assert.rejects(prepareImage(huge), /pixel|dimensions/i);
});

test("forged rendition association rejects even when both CAS hashes are valid", async () => {
  const original = await fixture("jpeg"),
    prepared = await prepareImage(original);
  const other = encodePng(1, 1, 3, new Uint8Array([1, 2, 3]));
  await assert.rejects(
    verifiedDisplay(
      {
        blobHash: sha256(original),
        rendition: { ...prepared.rendition!, blobHash: sha256(other) },
      },
      {
        async get(hash) {
          return hash === sha256(original) ? original : other;
        },
        async put(bytes) {
          return sha256(bytes);
        },
      },
    ),
    /relationship/,
  );
});

test("missing optional decoder is actionable in isolated worker without node_modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "missing-decoder-"));
  try {
    await copyFile(
      new URL("../src/adapters/parsing/image-worker.mjs", import.meta.url),
      join(root, "worker.mjs"),
    );
    const result = spawnSync(process.execPath, [join(root, "worker.mjs")], {
      input: await fixture("jpeg"),
      env: {},
      timeout: 15000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr.toString(), /Optional decoder unavailable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PNG legacy identity is exact and invalid later Markdown image causes zero commits", async () => {
  const root = await mkdtemp(join(tmpdir(), "png-identity-"));
  try {
    const png = encodePng(1, 1, 3, new Uint8Array([1, 2, 3]));
    await writeFile(join(root, "image.png"), png);
    let writes = 0;
    const store = {
      async put(bytes: Uint8Array) {
        writes++;
        return sha256(bytes);
      },
      async get() {
        throw new Error("unused");
      },
    };
    const result = await captureLocal(root, join(root, "image.png"), store);
    assert.equal(result.parserVersion, "local-text-png-pdf-v2");
    assert.ok(!Object.hasOwn(result.images[0]!, "rendition"));
    assert.equal(
      result.revision,
      sha256(
        JSON.stringify([
          sha256(png),
          "local-text-png-pdf-v2",
          [
            {
              id: "element_0",
              text: "image.png",
              locator: { kind: "anchor", anchor: "filename" },
            },
          ],
          [
            {
              id: "image_0",
              blobHash: sha256(png),
              locator: { kind: "anchor", anchor: "original" },
              originKind: "standalone_original",
              caption: "image.png",
              elementIds: ["element_0"],
            },
          ],
        ]),
      ),
    );
    await writeFile(join(root, "good.jpeg"), await fixture("jpeg"));
    await writeFile(join(root, "bad.webp"), "invalid");
    await writeFile(
      join(root, "input.md"),
      "![first](good.jpeg) ![bad](bad.webp)",
    );
    writes = 0;
    await assert.rejects(captureLocal(root, join(root, "input.md"), store));
    assert.equal(writes, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite retrieval and vision retain original authority but send PNG rendition bytes", async () => {
  const { KnowledgeRuntime } = await import(
    "../src/application/knowledge-runtime.ts"
  );
  const { enrichImage } = await import("../src/application/enrich-image.ts");
  const { visionFingerprints } = await import(
    "../src/adapters/models/grounded-model.ts"
  );
  const { createServer } = await import("node:http");
  const root = await mkdtemp(join(tmpdir(), "rendition-runtime-"));
  let request = "";
  const server = createServer(async (req, res) => {
    for await (const chunk of req) request += chunk.toString();
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "synthetic image" },
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const original = await fixture("webp");
    await writeFile(join(root, "image.webp"), original);
    await writeFile(join(root, "guide.md"), "scheduler ![diagram](image.webp)");
    const data = join(root, "data"),
      runtime = new KnowledgeRuntime(data);
    const capture = await runtime.ingest(root, join(root, "guide.md"));
    const result = await new KnowledgeRuntime(data).search("scheduler");
    assert.deepEqual(
      result.bundle.images[0]!.rendition,
      capture.images[0]!.rendition,
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const config = {
      endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`,
      model: "fixture",
      approved: true,
    };
    const hint = await enrichImage(
      data,
      capture.id,
      "image_0",
      "Describe",
      "r1",
      config,
      true,
    );
    assert.equal(hint.blobHash, sha256(original));
    assert.notEqual(
      hint.modelFingerprint,
      visionFingerprints(config, "Describe", "r1").modelFingerprint,
    );
    const display = await new FileBlobStore(join(data, "blobs")).get(
      capture.images[0]!.rendition!.blobHash,
    );
    assert.ok(
      request.includes(
        `data:image/png;base64,${Buffer.from(display).toString("base64")}`,
      ),
    );
    assert.ok(!request.includes(original.toString("base64")));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("EXIF orientation is deliberately ignored; WebP alpha survives RGBA rendition", async () => {
  const jpeg = await sharp({
    create: { width: 3, height: 2, channels: 3, background: "red" },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  const prepared = await prepareImage(jpeg);
  assert.equal(prepared.rendition!.width, 3);
  assert.equal(prepared.rendition!.height, 2);
  const metadata = await sharp(prepared.display).metadata();
  assert.equal(metadata.exif, undefined);
  const webp = await prepareImage(await fixture("webp"));
  const pixels = await sharp(webp.display).raw().toBuffer();
  assert.ok(pixels[3]! > 0 && pixels[3]! < 255);
});

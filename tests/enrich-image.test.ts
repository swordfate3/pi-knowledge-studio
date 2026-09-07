import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import test from "node:test";
import { FileBlobStore } from "../src/adapters/blob/file-blob-store.ts";
import { SqliteCatalog } from "../src/adapters/storage/sqlite-catalog.ts";
import { visionFingerprints } from "../src/adapters/models/grounded-model.ts";
import { enrichImage } from "../src/application/enrich-image.ts";
import { captureRevision } from "../src/application/validate-capture.ts";

function png(): Buffer {
  function chunk(type: string, data: Buffer): Buffer {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length);
    out.write(type, 4);
    data.copy(out, 8);
    let crc = 0xffffffff;
    for (const byte of out.subarray(4, -4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
    return out;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function fixture(
  run: (context: {
    root: string;
    document: ReturnType<typeof makeDocument>;
    options: {
      endpoint: string;
      model: string;
      apiKey: string;
      approved: boolean;
    };
    requests: string[];
    respond: (description: string, before?: () => Promise<void>) => void;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "enrich-image-"));
  const requests: string[] = [];
  let description = 'Model claims sourceId="fabricated"; untrusted red pixel.';
  let before = async () => {};
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(Buffer.concat(chunks).toString());
    try {
      await before();
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: description,
              },
            },
          ],
        }),
      );
    } catch {
      res.statusCode = 500;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const blobs = new FileBlobStore(join(root, "blobs"));
    const sourceHash = await blobs.put(
      Buffer.from("Original source paragraph"),
    );
    const blobHash = await blobs.put(png());
    const document = makeDocument(sourceHash, blobHash);
    await SqliteCatalog.use(root, async (catalog) =>
      catalog.publish(document, 0),
    );
    await run({
      root,
      document,
      requests,
      options: {
        endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`,
        model: "vision-fixture",
        apiKey: "fixture-key",
        approved: true,
      },
      respond: (value, action) => {
        description = value;
        before = action ?? (async () => {});
      },
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
function makeDocument(sourceHash: string, blobHash: string) {
  const capture = {
    id: `doc_${"a".repeat(64)}`,
    sourceHash,
    label: "private source",
    parserVersion: "fixture-v1",
    elements: [
      {
        id: "e1",
        text: "Original source paragraph",
        locator: { kind: "page" as const, page: 1 },
      },
    ],
    images: [
      {
        id: "i1",
        blobHash,
        locator: { kind: "page" as const, page: 1 },
        originKind: "embedded_original" as const,
        caption: "Original caption",
        elementIds: ["e1"],
      },
    ],
  };
  return { ...capture, revision: captureRevision(capture) };
}

test("vision fingerprints bind canonical endpoint, explicit revision and full request, not credentials/deadline", () => {
  const options = {
    endpoint: "https://EXAMPLE.com:443/v1/chat/completions",
    model: "vision",
    approved: true,
  };
  const original = visionFingerprints(options, "Describe", "revision-1");
  assert.deepEqual(
    visionFingerprints(
      {
        ...options,
        endpoint: "https://example.com/v1/chat/completions",
        apiKey: "different-key",
        timeoutMs: 1000,
      },
      "Describe",
      "revision-1",
    ),
    original,
  );
  for (const changed of [
    visionFingerprints(
      { ...options, model: "other" },
      "Describe",
      "revision-1",
    ),
    visionFingerprints(
      { ...options, endpoint: "https://other.example/v1/chat/completions" },
      "Describe",
      "revision-1",
    ),
    visionFingerprints(options, "Describe differently", "revision-1"),
    visionFingerprints(options, "Describe", "revision-2"),
  ])
    assert.notEqual(changed.modelFingerprint, original.modelFingerprint);
  assert.notEqual(
    visionFingerprints(options, "Other", "revision-1").promptFingerprint,
    original.promptFingerprint,
  );
  assert.throws(() => visionFingerprints(options, "Describe", " "));
});

test("both approvals, active references and verified blobs required before any HTTP", async () => {
  await fixture(async ({ root, document, options, requests }) => {
    for (const [approved, persist] of [
      [false, false],
      [false, true],
      [true, false],
    ])
      await assert.rejects(
        enrichImage(
          root,
          document.id,
          "i1",
          "Describe",
          "r1",
          { ...options, approved: approved! },
          persist!,
        ),
        /approved/,
      );
    await assert.rejects(
      enrichImage(root, document.id, "i1", "Describe", "r1", options, true, 0),
      /since vision approval/,
    );
    await assert.rejects(
      enrichImage(root, "absent", "i1", "Describe", "r1", options, true),
      /document/,
    );
    await assert.rejects(
      enrichImage(root, document.id, "absent", "Describe", "r1", options, true),
      /image/,
    );
    await writeFile(join(root, "blobs", document.sourceHash), "tampered");
    await assert.rejects(
      enrichImage(root, document.id, "i1", "Describe", "r1", options, true),
      /integrity/,
    );
    assert.equal(requests.length, 0);
  });
});

test("enrichment snapshots options, sends only actual PNG/prompt and persists host-bound retrieval-only output", async () => {
  await fixture(async ({ root, document, options, requests }) => {
    const originalOptions = { ...options };
    const pending = enrichImage(
      root,
      document.id,
      "i1",
      "Describe",
      "r1",
      options,
      true,
    );
    options.model = "mutated";
    options.endpoint = "invalid";
    options.approved = false;
    const hint = await pending;
    assert.equal(hint.authority, "retrieval-only");
    assert.equal(hint.documentId, document.id);
    assert.equal(hint.revision, document.revision);
    assert.equal(hint.sourceHash, document.sourceHash);
    assert.equal(hint.blobHash, document.images[0]!.blobHash);
    assert.deepEqual(
      {
        modelFingerprint: hint.modelFingerprint,
        promptFingerprint: hint.promptFingerprint,
      },
      visionFingerprints(originalOptions, "Describe", "r1"),
    );
    const body = JSON.parse(requests[0]!);
    assert.equal(body.model, originalOptions.model);
    assert.match(body.messages[0].content, /not source evidence/);
    assert.deepEqual(body.messages[1].content, [
      { type: "text", text: "Describe" },
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${png().toString("base64")}` },
      },
    ]);
    assert.ok(!requests[0]!.includes(document.elements[0]!.text));
    assert.ok(!requests[0]!.includes(document.id));
    const snapshot = await SqliteCatalog.use(root, async (catalog) =>
      catalog.snapshot(),
    );
    assert.deepEqual(snapshot.documents, [document]);
    assert.deepEqual(snapshot.hints, [hint]);
    assert.ok(Object.isFrozen(hint));
  });
});

test("catalog source deletion during request rejects guarded persistence", async () => {
  await fixture(async ({ root, document, options, requests, respond }) => {
    respond("A pixel", async () => {
      await SqliteCatalog.use(root, async (catalog) => {
        catalog.remove(document.id);
      });
    });
    await assert.rejects(
      enrichImage(root, document.id, "i1", "Describe", "r1", options, true),
      /Catalog changed/,
    );
    assert.equal(requests.length, 1);
    assert.deepEqual(
      await SqliteCatalog.use(
        root,
        async (catalog) => catalog.snapshot().hints,
      ),
      [],
    );
  });
});

test("physical source deletion during request also rejects persistence", async () => {
  await fixture(async ({ root, document, options, respond }) => {
    respond("A pixel", async () => {
      await rm(join(root, "blobs", document.sourceHash));
    });
    await assert.rejects(
      enrichImage(root, document.id, "i1", "Describe", "r1", options, true),
    );
    assert.deepEqual(
      await SqliteCatalog.use(
        root,
        async (catalog) => catalog.snapshot().hints,
      ),
      [],
    );
  });
});

test("hint output cap is 16000, stricter than describeImage", async () => {
  await fixture(async ({ root, document, options, respond }) => {
    respond("x".repeat(16001));
    await assert.rejects(
      enrichImage(root, document.id, "i1", "Describe", "r1", options, true),
      /16000/,
    );
    assert.deepEqual(
      await SqliteCatalog.use(
        root,
        async (catalog) => catalog.snapshot().hints,
      ),
      [],
    );
    respond("x".repeat(16000));
    const hint = await enrichImage(
      root,
      document.id,
      "i1",
      "Describe",
      "r1",
      options,
      true,
    );
    assert.equal(hint.description.length, 16000);
  });
});

test("committed deletion before dispatch callback prevents vision HTTP", async (t) => {
  await fixture(async ({ root, document, options, requests }) => {
    const use = SqliteCatalog.use;
    let calls = 0;
    t.mock.method(SqliteCatalog, "use", async function <
      T,
    >(data: string, operation: (catalog: SqliteCatalog) => Promise<T>): Promise<T> {
      const current = ++calls;
      return use.call(SqliteCatalog, data, async (catalog) => {
        if (current === 2) catalog.remove(document.id);
        return operation(catalog);
      }) as Promise<T>;
    });
    try {
      await assert.rejects(
        enrichImage(root, document.id, "i1", "Describe", "r1", options, true),
        /changed/i,
      );
      assert.equal(requests.length, 0);
    } finally {
      t.mock.restoreAll();
    }
  });
});

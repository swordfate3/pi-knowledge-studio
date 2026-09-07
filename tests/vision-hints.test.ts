import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqliteCatalog } from "../src/adapters/storage/sqlite-catalog.ts";
import { captureRevision } from "../src/application/validate-capture.ts";
import {
  createVisionHint,
  lexicalHintHits,
  validateVisionHint,
} from "../src/application/vision-hints.ts";
import type { CapturedDocument } from "../src/domain/retrieval.ts";

function capture(
  linked = true,
  text = "Original source paragraph",
): CapturedDocument {
  const document = {
    id: `doc_${"a".repeat(64)}`,
    sourceHash: "b".repeat(64),
    label: "source",
    parserVersion: "test",
    elements: [{ id: "e1", text, locator: { kind: "page" as const, page: 1 } }],
    images: [
      {
        id: "i1",
        blobHash: "c".repeat(64),
        locator: { kind: "page" as const, page: 1 },
        originKind: "embedded_original" as const,
        caption: "",
        elementIds: linked ? ["e1"] : [],
      },
    ],
  };
  return { ...document, revision: captureRevision(document) };
}
function hint(document = capture(), description = "turquoise semaphore 调度") {
  return createVisionHint(document, {
    documentId: document.id,
    revision: document.revision,
    sourceHash: document.sourceHash,
    imageId: "i1",
    blobHash: document.images[0]!.blobHash,
    modelFingerprint: "d".repeat(64),
    promptFingerprint: "e".repeat(64),
    description,
  });
}
async function withRoot(operation: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "vision-hints-"));
  try {
    await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("host derivation binds every reference, validates fields and excludes output from ID", () => {
  const document = capture(),
    record = hint(document);
  assert.ok(Object.isFrozen(record));
  assert.equal(record.authority, "retrieval-only");
  assert.equal(hint(document, "different output").id, record.id);
  assert.notEqual(
    hint(document, "different output").descriptionHash,
    record.descriptionHash,
  );
  for (const [key, value] of Object.entries({
    id: "hint_" + "f".repeat(64),
    documentId: "doc_" + "f".repeat(64),
    revision: "f".repeat(64),
    sourceHash: "f".repeat(64),
    imageId: "absent",
    blobHash: "f".repeat(64),
    modelFingerprint: "f".repeat(64),
    promptFingerprint: "f".repeat(64),
    description: "tampered",
    descriptionHash: "f".repeat(64),
    authority: "evidence",
  }))
    assert.throws(() =>
      validateVisionHint({ ...record, [key]: value }, document),
    );
  for (const key of Object.keys(record)) {
    assert.throws(() =>
      validateVisionHint({ ...record, [key]: null }, document),
    );
    const missing = { ...record } as Record<string, unknown>;
    delete missing[key];
    assert.throws(() => validateVisionHint(missing, document));
  }
  assert.throws(() => validateVisionHint({ ...record, extra: true }, document));
  assert.throws(() => hint(document, "x".repeat(16_001)));
  assert.throws(() => hint(document, "  "));
  assert.equal(hint(document, "x".repeat(16_000)).description.length, 16_000);
  assert.throws(() => validateVisionHint(record, capture(true, "changed")));
});

test("hint tokens map to original elements, never description authority or fabricated text", () => {
  const document = capture(),
    before = JSON.stringify(document),
    record = hint(document);
  const hits = lexicalHintHits("TURQUOISE 调度", [document], [record, record]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.document, document);
  assert.equal(hits[0]!.element, document.elements[0]);
  assert.equal(hits[0]!.element.text, "Original source paragraph");
  assert.equal(JSON.stringify(document), before);
  assert.deepEqual(lexicalHintHits("absent", [document], [record]), []);
  assert.deepEqual(lexicalHintHits("!!!", [document], [record]), []);
  assert.deepEqual(
    lexicalHintHits("turquoise", [capture(true, "new")], [record]),
    [],
  );
  assert.throws(
    () =>
      lexicalHintHits(
        "turquoise",
        [document],
        [record, hint(document, "other")],
      ),
    /conflict/,
  );
  const unlinked = capture(false);
  assert.deepEqual(
    lexicalHintHits("turquoise", [unlinked], [hint(unlinked)]),
    [],
  );
  const imageOnly = { ...unlinked, elements: [] };
  imageOnly.revision = captureRevision(imageOnly);
  assert.deepEqual(
    lexicalHintHits("turquoise", [imageOnly], [hint(imageOnly)]),
    [],
  );
});

test("immutable hints persist, same output is idempotent and conflicts roll back", async () => {
  await withRoot(async (root) => {
    const document = capture(),
      record = hint(document);
    await SqliteCatalog.use(root, async (catalog) => {
      catalog.publish(document, 0);
      catalog.saveHint(record, 1);
      assert.equal(catalog.epoch(), 2);
      catalog.saveHint({ ...record }, 2);
      assert.equal(catalog.epoch(), 2);
      assert.throws(
        () => catalog.saveHint(hint(document, "conflicting"), 2),
        /conflict/,
      );
      assert.equal(catalog.epoch(), 2);
      assert.deepEqual(catalog.snapshot().hints, [record]);
      assert.throws(
        () => catalog.db.exec("UPDATE hints SET payload=payload"),
        /Immutable hint/,
      );
      assert.throws(
        () => catalog.db.exec("DELETE FROM hints"),
        /Immutable hint/,
      );
      assert.throws(
        () =>
          catalog.db
            .prepare("INSERT OR REPLACE INTO hints VALUES (?,?,?,?)")
            .run(
              record.id,
              document.id,
              document.revision,
              JSON.stringify(hint(document, "replacement")),
            ),
        /Immutable hint/,
      );
      assert.throws(
        () =>
          catalog.db
            .prepare("INSERT INTO hints VALUES (?,?,?,?)")
            .run("missing", document.id, "f".repeat(64), "{}"),
        /FOREIGN KEY/,
      );
    });
    await SqliteCatalog.use(root, async (catalog) => {
      assert.deepEqual(catalog.snapshot().hints, [record]);
      catalog.saveHint(record, 2);
      assert.equal(catalog.epoch(), 2);
      assert.throws(
        () => catalog.db.exec("DELETE FROM hints"),
        /Immutable hint/,
      );
    });
  });
});

test("stale epochs, replaced/removed revisions and mismatched stored bindings reject writes", async () => {
  await withRoot(async (root) =>
    SqliteCatalog.use(root, async (catalog) => {
      const document = capture(),
        record = hint(document);
      catalog.publish(document, 0);
      assert.throws(() => catalog.saveHint(record, 0), /Catalog changed/);
      assert.throws(
        () => catalog.saveHint({ ...record, blobHash: "f".repeat(64) }, 1),
        /binding/,
      );
      catalog.saveHint(record, 1);
      assert.throws(() => catalog.saveHint(record, 1), /Catalog changed/);
      catalog.publish(capture(true, "replacement"), 2);
      assert.deepEqual(catalog.snapshot().hints, []);
      assert.throws(() => catalog.saveHint(record, 3), /no longer active/);
      catalog.remove(document.id);
      assert.throws(() => catalog.saveHint(record, 4), /no longer active/);
      assert.deepEqual(catalog.snapshot().hints, []);
      catalog.publish(document, 4);
      assert.deepEqual(catalog.snapshot().hints, [record]);
    }),
  );
});

test("snapshot validates hint payload, full capture binding and SQL identity", async () => {
  await withRoot(async (root) =>
    SqliteCatalog.use(root, async (catalog) => {
      const document = capture(),
        record = hint(document);
      catalog.publish(document, 0);
      catalog.saveHint(record, 1);
      catalog.db.exec("DROP TRIGGER hints_immutable_update");
      for (const payload of [
        "{",
        JSON.stringify({ ...record, description: "bad" }),
        JSON.stringify({ ...record, sourceHash: "f".repeat(64) }),
      ]) {
        catalog.db.prepare("UPDATE hints SET payload=?").run(payload);
        assert.throws(() => catalog.snapshot(), /Invalid stored hint/);
      }
      catalog.db
        .prepare("UPDATE hints SET payload=?,id=?")
        .run(JSON.stringify(record), "wrong");
      assert.throws(() => catalog.snapshot(), /identity/);
      catalog.db.prepare("UPDATE hints SET id=?").run(record.id);
      assert.deepEqual(catalog.snapshot().hints, [record]);
      catalog.db.exec("DROP TRIGGER revisions_immutable_update");
      catalog.db
        .prepare("UPDATE revisions SET payload=?")
        .run(JSON.stringify(capture(true, "forged")));
      assert.throws(() => catalog.saveHint(record, 2), /identity/);
    }),
  );
});

test("hints share the document/epoch read snapshot across concurrent commits", async () => {
  await withRoot(async (root) =>
    SqliteCatalog.use(root, async (catalog) => {
      catalog.db.exec("PRAGMA journal_mode=WAL");
      const document = capture(),
        record = hint(document);
      catalog.publish(document, 0);
      const writerDb = new DatabaseSync(join(root, "catalog.sqlite"));
      const writer = new SqliteCatalog(writerDb),
        epoch = catalog.epoch.bind(catalog);
      catalog.epoch = () => {
        const value = epoch();
        writer.saveHint(record, 1);
        return value;
      };
      try {
        const snapshot = catalog.snapshot();
        assert.equal(snapshot.epoch, 1);
        assert.deepEqual(snapshot.hints, []);
        assert.deepEqual(snapshot.documents, [document]);
      } finally {
        catalog.epoch = epoch;
        writerDb.close();
      }
      assert.equal(catalog.snapshot().epoch, 2);
      assert.deepEqual(catalog.snapshot().hints, [record]);
    }),
  );
});

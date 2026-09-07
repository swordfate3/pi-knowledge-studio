import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqliteCatalog } from "../src/adapters/storage/sqlite-catalog.ts";
import { captureRevision } from "../src/application/validate-capture.ts";
import { KnowledgeRuntime } from "../src/application/knowledge-runtime.ts";
import { encodePng } from "../src/adapters/export/encode-png.ts";
import type { CapturedDocument } from "../src/domain/retrieval.ts";

function fixture(seed = "a"): CapturedDocument {
  const document = {
    id: `doc_${seed.repeat(64)}`,
    label: "transaction fixture",
    sourceHash: "c".repeat(64),
    parserVersion: "transaction-v1",
    elements: [
      {
        id: "e1",
        text: "original text",
        locator: { kind: "lines" as const, start: 1, end: 1 },
      },
    ],
    images: [],
  };
  return { ...document, revision: captureRevision(document) };
}
async function isolated(operation: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "studio-transaction-"));
  try {
    await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("publication SQL failure rolls back newly inserted revision, active pointer and epoch", async () => {
  await isolated((root) =>
    SqliteCatalog.use(root, async (catalog) => {
      catalog.db.exec(
        "CREATE TEMP TRIGGER fail_publish BEFORE INSERT ON active BEGIN SELECT RAISE(ABORT, 'injected publication failure'); END;",
      );
      assert.throws(
        () => catalog.publish(fixture(), 0),
        /injected publication failure/,
      );
      assert.equal(catalog.epoch(), 0);
      assert.deepEqual(catalog.documents(), []);
      assert.equal(
        catalog.db.prepare("SELECT COUNT(*) AS n FROM revisions").get()?.n,
        0,
      );
      catalog.db.exec("DROP TRIGGER fail_publish");
      catalog.publish(fixture(), 0);
      assert.equal(catalog.epoch(), 1);
    }),
  );
});

test("removal SQL failure restores active document and epoch", async () => {
  await isolated((root) =>
    SqliteCatalog.use(root, async (catalog) => {
      const document = fixture();
      catalog.publish(document, 0);
      catalog.db.exec(
        "CREATE TEMP TRIGGER fail_epoch BEFORE UPDATE ON metadata BEGIN SELECT RAISE(ABORT, 'injected epoch failure'); END;",
      );
      assert.throws(
        () => catalog.remove(document.id),
        /injected epoch failure/,
      );
      assert.equal(catalog.epoch(), 1);
      assert.deepEqual(catalog.documents(), [document]);
      catalog.db.exec("DROP TRIGGER fail_epoch");
      catalog.remove(document.id);
      assert.equal(catalog.epoch(), 2);
      assert.deepEqual(catalog.documents(), []);
    }),
  );
});

test("two catalog connections cannot publish at the same epoch or resurrect a removed document", async () => {
  await isolated((root) =>
    SqliteCatalog.use(root, async (first) => {
      const db = new DatabaseSync(join(root, "catalog.sqlite"));
      try {
        const second = new SqliteCatalog(db);
        const epoch = second.epoch();
        first.publish(fixture(), epoch);
        assert.throws(
          () => second.publish(fixture("b"), epoch),
          /changed|stale/i,
        );
        assert.equal(
          first.db.prepare("SELECT COUNT(*) AS n FROM revisions").get()?.n,
          1,
        );
        const beforeRemoval = second.epoch();
        first.remove(fixture().id);
        assert.throws(
          () => second.publish(fixture(), beforeRemoval),
          /changed|stale/i,
        );
        assert.deepEqual(first.documents(), []);
        assert.equal(first.epoch(), 2);
      } finally {
        db.close();
      }
    }),
  );
});

test("offline whole-collection copy restores source and original image hashes without original files", async () => {
  await isolated(async (root) => {
    const input = join(root, "input"),
      original = join(root, "original"),
      restored = join(root, "restored");
    await mkdir(input, { mode: 0o700 });
    await mkdir(original, { mode: 0o700 });
    const png = encodePng(1, 1, 3, new Uint8Array([9, 80, 190]));
    const text =
      "Offline restoration preserves source evidence.\n![original diagram](diagram.png)";
    await writeFile(join(input, "diagram.png"), png);
    await writeFile(join(input, "source.md"), text);
    const runtime = new KnowledgeRuntime(original);
    await runtime.ingest(input, join(input, "source.md"));
    const before = await runtime.search("restoration");
    // All use() connections are closed and no jobs/writers are running here.
    await cp(original, restored, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    await rm(original, { recursive: true });
    await rm(input, { recursive: true });
    const recovered = new KnowledgeRuntime(restored);
    const after = await recovered.search("restoration");
    assert.notEqual(after.bundle.id, before.bundle.id); // Per-query IDs are intentionally fresh.
    assert.equal(after.bundle.snapshotId, before.bundle.snapshotId);
    assert.deepEqual(after.bundle.sources, before.bundle.sources);
    assert.deepEqual(after.bundle.texts, before.bundle.texts);
    assert.deepEqual(after.bundle.images, before.bundle.images);
    const snapshot = await SqliteCatalog.use(restored, async (catalog) =>
      catalog.snapshot(),
    );
    assert.equal(snapshot.documents.length, 1);
    const document = snapshot.documents[0]!;
    assert.equal(
      Buffer.from(await recovered.blobs.get(document.sourceHash)).toString(
        "utf8",
      ),
      text,
    );
    assert.deepEqual(
      Buffer.from(await recovered.blobs.get(document.images[0]!.blobHash)),
      png,
    );
  });
});

test("retained revisions refuse replacement on reopen and independent SQL connections", async () => {
  await isolated(async (root) => {
    const document = fixture();
    await SqliteCatalog.use(root, async (catalog) => {
      catalog.publish(document, 0);
      catalog.remove(document.id);
      catalog.publish(document, 2); // Identical history is reactivated, not inserted.
      catalog.publish(document, 3); // Identical active publication also skips INSERT.
      assert.equal(catalog.epoch(), 4);
      assert.equal(catalog.db.prepare("SELECT count(*) AS n FROM revisions").get()?.n, 1);
    });
    await SqliteCatalog.use(root, async (catalog) => {
      const separate = new DatabaseSync(join(root, "catalog.sqlite"));
      try {
        for (const db of [catalog.db, separate]) {
          db.exec("PRAGMA recursive_triggers=OFF");
          for (const verb of ["INSERT OR REPLACE", "REPLACE", "INSERT OR IGNORE", "INSERT"])
            assert.throws(() => db.prepare(`${verb} INTO revisions VALUES (?,?,?)`)
              .run(document.id, document.revision, "changed"), /Immutable revision: replacement forbidden/);
          assert.equal(db.prepare("SELECT payload FROM revisions").get()?.payload, JSON.stringify(document));
        }
        assert.deepEqual(catalog.documents(), [document]);
        assert.equal(catalog.epoch(), 4);
      } finally { separate.close(); }
    });
  });
});

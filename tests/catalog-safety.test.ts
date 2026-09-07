import assert from "node:assert/strict";
import {
  chmod,
  chown,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  SqliteCatalog,
  spaceKey,
} from "../src/adapters/storage/sqlite-catalog.ts";
import { captureRevision } from "../src/application/validate-capture.ts";
import type {
  CapturedDocument,
  EmbeddingSpace,
} from "../src/domain/retrieval.ts";

const space: EmbeddingSpace = {
  provider: "test",
  model: "test",
  revision: "1",
  dimension: 2,
  queryInstruction: "",
  documentInstruction: "",
};
function capture(seed = "a", text = "original"): CapturedDocument {
  const document = {
    id: `doc_${seed.repeat(64)}`,
    label: "test",
    sourceHash: "c".repeat(64),
    parserVersion: "test-v1",
    elements: [
      { id: "e1", text, locator: { kind: "lines" as const, start: 1, end: 1 } },
    ],
    images: [],
  };
  return { ...document, revision: captureRevision(document) };
}
async function withRoot(
  operation: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "catalog-safety-"));
  try {
    await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("snapshot is synchronous, keyed by document ID, active-only and space-scoped", async () => {
  await withRoot(async (root) =>
    SqliteCatalog.use(root, async (catalog) => {
      const original = capture(),
        other = capture("b");
      catalog.publish(original, 0);
      catalog.saveVectors(original, space, [[1, 0]], 1);
      catalog.publish(other, 1);
      const snapshot = catalog.snapshot(space);
      assert.equal(snapshot.epoch, 2);
      assert.deepEqual(snapshot.documents, [original, other]);
      assert.deepEqual(
        snapshot.vectors,
        new Map([
          [original.id, new Map([["e1", [1, 0]]])],
          [other.id, new Map()],
        ]),
      );
      assert.deepEqual(catalog.snapshot().vectors, new Map());
      assert.equal(
        catalog
          .snapshot({ ...space, revision: "other" })
          .vectors.get(original.id)?.size,
        0,
      );
      snapshot.documents[0]!.label = "mutated";
      snapshot.vectors.get(original.id)!.get("e1")![0] = 9;
      assert.equal(
        catalog.snapshot(space).vectors.get(original.id)!.get("e1")![0],
        1,
      );
      const updated = capture("a", "updated");
      catalog.publish(updated, 2);
      catalog.remove(other.id);
      assert.deepEqual(catalog.snapshot(space), {
        epoch: 4,
        documents: [updated],
        vectors: new Map([[updated.id, new Map()]]),
        hints: [],
      });
    }),
  );
});

test("snapshot retains epoch, documents and vectors across another connection's commit", async () => {
  await withRoot(async (root) =>
    SqliteCatalog.use(root, async (catalog) => {
      catalog.db.exec("PRAGMA journal_mode=WAL");
      const document = capture();
      catalog.publish(document, 0);
      catalog.saveVectors(document, space, [[1, 0]], 1);
      const writerDb = new DatabaseSync(join(root, "catalog.sqlite"));
      const writer = new SqliteCatalog(writerDb);
      const epoch = catalog.epoch.bind(catalog);
      catalog.epoch = () => {
        const value = epoch();
        writerDb.prepare("UPDATE vectors SET vector=?").run("[0,1]");
        writer.remove(document.id);
        return value;
      };
      try {
        assert.deepEqual(catalog.snapshot(space), {
          epoch: 1,
          documents: [document],
          vectors: new Map([[document.id, new Map([["e1", [1, 0]]])]]),
          hints: [],
        });
      } finally {
        catalog.epoch = epoch;
        writerDb.close();
      }
      assert.deepEqual(catalog.snapshot(space), {
        epoch: 2,
        documents: [],
        vectors: new Map(),
        hints: [],
      });
    }),
  );
});

test("snapshot rejects corrupt captures, vectors and epochs and rolls back failed reads", async () => {
  await withRoot(async (root) =>
    SqliteCatalog.use(root, async (catalog) => {
      const document = capture();
      catalog.publish(document, 0);
      catalog.saveVectors(document, space, [[1, 0]], 1);
      for (const vector of [
        "not json",
        "[1]",
        "[0,0]",
        "[1e999,0]",
        '["1",0]',
      ]) {
        catalog.db.prepare("UPDATE vectors SET vector=?").run(vector);
        assert.throws(() => catalog.snapshot(space), /Invalid catalog vector/);
      }
      catalog.db
        .prepare("UPDATE vectors SET vector=?, element_id=?")
        .run("[1,0]", "unknown");
      assert.throws(
        () => catalog.snapshot(space),
        /Invalid catalog vector record/,
      );
      catalog.db.prepare("UPDATE vectors SET element_id=?").run("e1");
      assert.equal(catalog.snapshot(space).epoch, 1);
      catalog.db.exec("DROP TRIGGER revisions_immutable_update");
      for (const payload of [
        "{",
        JSON.stringify({ ...document, id: capture("b").id }),
        JSON.stringify({ ...document, elements: [] }),
      ]) {
        catalog.db.prepare("UPDATE revisions SET payload=?").run(payload);
        assert.throws(() => catalog.snapshot(), /capture|identity|revision/i);
      }
      catalog.db
        .prepare("UPDATE revisions SET payload=?")
        .run(JSON.stringify(document));
      catalog.db.exec("UPDATE metadata SET value=-1");
      assert.throws(() => catalog.snapshot(), /Invalid catalog epoch/);
      catalog.db.exec("UPDATE metadata SET value=1");
      assert.equal(catalog.snapshot(space).vectors.get(document.id)?.size, 1);
      assert.equal(spaceKey(space), spaceKey({ ...space }));
    }),
  );
});

test("revision UPDATE and DELETE are forbidden, including inactive records after reopening", async () => {
  await withRoot(async (root) => {
    await SqliteCatalog.use(root, async (catalog) => {
      catalog.publish(capture(), 0);
      assert.throws(
        () => catalog.db.exec("UPDATE revisions SET payload=payload"),
        /Immutable revision/,
      );
      catalog.remove(capture().id);
    });
    await SqliteCatalog.use(root, async (catalog) => {
      assert.throws(
        () => catalog.db.exec("DELETE FROM revisions"),
        /Immutable revision/,
      );
      assert.equal(
        catalog.db.prepare("SELECT COUNT(*) AS n FROM revisions").get()?.n,
        1,
      );
      catalog.publish(capture(), catalog.epoch());
      assert.equal(catalog.documents().length, 1);
    });
  });
});

test("POSIX catalog creates private DB and sidecars without changing umask", {
  skip: process.platform === "win32",
}, async () => {
  const mask = process.umask();
  await withRoot(async (root) =>
    SqliteCatalog.use(root, async (catalog) => {
      assert.equal(
        (await lstat(join(root, "catalog.sqlite"))).mode & 0o777,
        0o600,
      );
      catalog.db.exec("BEGIN IMMEDIATE; UPDATE metadata SET value=value+1");
      assert.equal(
        (await lstat(join(root, "catalog.sqlite-journal"))).mode & 0o077,
        0,
      );
      catalog.db.exec("COMMIT; PRAGMA journal_mode=WAL");
      catalog.publish(capture(), catalog.epoch());
      for (const name of [
        "catalog.sqlite",
        "catalog.sqlite-wal",
        "catalog.sqlite-shm",
      ]) {
        const info = await lstat(join(root, name));
        assert.equal(info.mode & 0o077, 0);
        assert.equal(info.uid, process.getuid?.());
      }
    }),
  );
  assert.equal(process.umask(), mask);
});

test("POSIX unsafe directory and DB/sidecars are rejected without modification", {
  skip: process.platform === "win32",
}, async () => {
  await withRoot(async (root) => {
    await chmod(root, 0o755);
    await assert.rejects(
      SqliteCatalog.use(root, async () => {}),
      /private owned directory/,
    );
    assert.equal((await lstat(root)).mode & 0o777, 0o755);
  });
  for (const name of [
    "catalog.sqlite",
    "catalog.sqlite-wal",
    "catalog.sqlite-shm",
    "catalog.sqlite-journal",
  ]) {
    await withRoot(async (root) => {
      const path = join(root, name);
      await writeFile(path, "untouched", { mode: 0o600 });
      await chmod(path, 0o644);
      await assert.rejects(
        SqliteCatalog.use(root, async () => {}),
        /Unsafe catalog file/,
      );
      assert.equal((await lstat(path)).mode & 0o777, 0o644);
      assert.equal(await readFile(path, "utf8"), "untouched");
    });
    await withRoot(async (root) => {
      await symlink("missing", join(root, name));
      await assert.rejects(
        SqliteCatalog.use(root, async () => {}),
        /Unsafe catalog file/,
      );
    });
  }
});

test("POSIX foreign-owned directory and catalog files are rejected", {
  skip: process.platform === "win32" || process.getuid?.() !== 0,
}, async (context) => {
  let canChown = true;
  await withRoot(async (root) => {
    try {
      await chown(root, 65534, 65534);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EPERM"
      )
        throw error;
      canChown = false;
      context.skip("Environment lacks permission to change file ownership");
      return;
    }
    await assert.rejects(
      SqliteCatalog.use(root, async () => {}),
      /private owned directory/,
    );
  });
  if (!canChown) return;
  for (const name of [
    "catalog.sqlite",
    "catalog.sqlite-wal",
    "catalog.sqlite-shm",
    "catalog.sqlite-journal",
  ]) {
    await withRoot(async (root) => {
      const path = join(root, name);
      await writeFile(path, "untouched", { mode: 0o600 });
      await chown(path, 65534, 65534);
      await assert.rejects(
        SqliteCatalog.use(root, async () => {}),
        /Unsafe catalog file/,
      );
      assert.equal((await lstat(path)).uid, 65534);
    });
  }
});

import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exportEvaluationDocument } from "../scripts/evaluate-answer-acceptance.ts";
import { exportPortableDocument } from "../src/adapters/export/portable-export.ts";
import { FileBlobStore, sha256 } from "../src/adapters/blob/file-blob-store.ts";
import type { EvidenceBundle, IllustratedDocument } from "../src/domain/evidence.ts";

// Entirely synthetic text; no corpus assets, model calls, or gold inputs.
const text = "Synthetic offline evidence.";
const bundle: EvidenceBundle = {
  schemaVersion: 1, id: "bundle1", snapshotId: "snapshot1",
  sources: [{ id: "source1", label: "Synthetic", revisionHash: sha256(text) }],
  texts: [{ id: "text1", sourceId: "source1", elementId: "element1",
    locator: { kind: "lines", start: 1, end: 1 }, text, textHash: sha256(text), start: 0, end: text.length }],
  images: [],
};
const document: IllustratedDocument = {
  title: "Offline export", bundleId: bundle.id, mode: "evidence-compilation",
  blocks: [{ kind: "paragraph", text, evidenceIds: ["text1"] }],
};
const permission = { documentContent: true, images: false, excerpts: true };

test("evaluation creates missing nested private roots and a complete package without inference", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluation-export-"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("No network permitted in export test"); };
  try {
    const output = join(root, "run", "exports", "A01");
    const blobs = new FileBlobStore(join(root, "blobs"));
    // Preserve production's existing-root contract.
    await assert.rejects(exportPortableDocument(output, bundle, document, permission, blobs));
    const path = await exportEvaluationDocument(output, bundle, document, permission, blobs);
    for (const directory of [join(root, "run"), join(root, "run", "exports"), output, path]) {
      assert.ok((await stat(directory)).isDirectory());
      if (process.platform !== "win32") assert.equal((await stat(directory)).mode & 0o777, 0o700);
    }
    const manifest = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.files.map((f: { path: string }) => f.path).sort(),
      ["document.html", "document.md", "evidence.json", "sources.json"]);
    for (const file of manifest.files) {
      const bytes = await readFile(join(path, file.path));
      assert.equal(sha256(bytes), file.sha256);
      assert.equal(bytes.length, file.byteLength);
    }
    assert.ok((await readFile(join(path, "document.html"), "utf8")).includes(text));
    const second = await exportEvaluationDocument(output, bundle, document, permission, blobs);
    assert.notEqual(second, path);
    assert.equal((await readdir(output)).length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("evaluation rejects symlink leaves and ancestors without writing through them", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluation-export-"));
  try {
    const target = join(root, "target");
    await mkdir(target, { mode: 0o700 });
    const alias = join(root, "alias");
    await symlink(target, alias, "dir");
    for (const output of [alias, join(alias, "exports", "A01")])
      await assert.rejects(exportEvaluationDocument(output, bundle, document, permission, new FileBlobStore(join(root, "blobs"))));
    assert.deepEqual(await readdir(target), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("evaluation does not repair or accept an existing writable export root", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluation-export-"));
  try {
    const output = join(root, "output");
    await mkdir(output);
    await chmod(output, 0o777);
    await assert.rejects(exportEvaluationDocument(output, bundle, document, permission, new FileBlobStore(join(root, "blobs"))), /not writable/);
    assert.equal((await stat(output)).mode & 0o777, 0o777);
    assert.deepEqual(await readdir(output), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkedStudioPaths, defaultStudioRoot, projectStudioPaths } from "../src/core/studio-paths.ts";
import { resolveDataRoot } from "../src/config.ts";
import { saveCollection, loadCollection } from "../src/storage/store.ts";

test("project paths are isolated, read-only, and V1 cannot collide with V2", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "studio-layout-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const paths = projectStudioPaths(cwd);
  assert.deepEqual(await readdir(cwd), []);
  for (const [key, child] of Object.entries({ collections: "collections", pdfJobs: "pdf-jobs", pdfGenerations: "pdf-generations", exports: "exports", legacyV1: "legacy-v1" }))
    assert.equal(paths[key as keyof typeof paths], join(cwd, ".pi", "knowledge-studio", child));
  assert.notEqual(projectStudioPaths(join(cwd, "other")).root, paths.root);
  assert.equal(defaultStudioRoot(), join(homedir(), ".pi", "knowledge-studio"));
  const saved = process.env.PI_KNOWLEDGE_STUDIO_HOME;
  try {
    delete process.env.PI_KNOWLEDGE_STUDIO_HOME;
    assert.equal(resolveDataRoot(cwd), paths.legacyV1);
    process.env.PI_KNOWLEDGE_STUDIO_HOME = join(cwd, "custom");
    assert.equal(resolveDataRoot(cwd), join(cwd, "custom"));
  } finally {
    if (saved === undefined) delete process.env.PI_KNOWLEDGE_STUDIO_HOME;
    else process.env.PI_KNOWLEDGE_STUDIO_HOME = saved;
  }
  await saveCollection(paths.legacyV1, await loadCollection(paths.legacyV1, "demo", "general"));
  assert.equal((await loadCollection(paths.legacyV1, "demo")).manifest.name, "demo");
  assert.deepEqual(checkedStudioPaths(cwd, paths.root), paths);
  assert.deepEqual(await readdir(paths.root), ["legacy-v1"]);
});

for (const old of [".pi/knowledge-studio-v2", ".pi/knowledge-studio-v2-pdf-jobs", ".pi/knowledge-studio-v2-pdf-generations", "knowledge-studio-v2-exports", ".pi/knowledge-studio/collections/demo"]) {
  test(`legacy storage blocks without mutation: ${old}`, async t => {
    const cwd = await mkdtemp(join(tmpdir(), "studio-upgrade-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const source = join(cwd, old);
    await mkdir(source, { recursive: true, mode: 0o700 });
    await writeFile(join(source, "collection.json"), "original bytes");
    const paths = projectStudioPaths(cwd);
    await mkdir(paths.exports, { recursive: true, mode: 0o700 });
    assert.throws(() => checkedStudioPaths(cwd, paths.root), /Legacy Studio storage detected.*no data was moved.*docs\/storage-layout.md/s);
    assert.equal(await readFile(join(source, "collection.json"), "utf8"), "original bytes");
    assert.deepEqual(await readdir(paths.exports), []);
  });
}

test("quiescent V1 relocation preserves relative JSON store and symlink roots fail closed", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "studio-v1-upgrade-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const paths = projectStudioPaths(cwd);
  await saveCollection(paths.root, await loadCollection(paths.root, "original", "general"));
  assert.throws(() => checkedStudioPaths(cwd, paths.root), /Legacy Studio storage/);
  await mkdir(paths.legacyV1, { mode: 0o700 });
  await rename(paths.collections, join(paths.legacyV1, "collections"));
  assert.deepEqual(checkedStudioPaths(cwd, paths.root), paths);
  assert.equal((await loadCollection(paths.legacyV1, "original")).manifest.name, "original");
  await symlink(paths.legacyV1, paths.collections);
  assert.throws(() => checkedStudioPaths(cwd, paths.root), /Unsafe Studio directory/);
});

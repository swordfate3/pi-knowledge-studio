import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkedStudioPaths, defaultStudioRoot, studioPaths } from "../src/core/studio-paths.ts";

test("Studio paths are isolated and resolving them performs no writes", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "studio-layout-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const root = join(cwd, ".pi", "knowledge-studio");
  const paths = studioPaths(cwd, root);
  assert.deepEqual(await readdir(cwd), []);
  for (const [key, child] of Object.entries({
    collections: "collections",
    pdfJobs: "pdf-jobs",
    pdfGenerations: "pdf-generations",
    exports: "exports",
  })) assert.equal(paths[key as keyof typeof paths], join(root, child));
  assert.equal(defaultStudioRoot(), join(homedir(), ".pi", "knowledge-studio"));
  assert.deepEqual(checkedStudioPaths(cwd, root), paths);
  assert.deepEqual(await readdir(cwd), []);
});

for (const old of [
  ".pi/knowledge-studio/legacy-v1/collections",
  ".pi/knowledge-studio-v2",
  ".pi/knowledge-studio-v2-pdf-jobs",
  ".pi/knowledge-studio-v2-pdf-generations",
  "knowledge-studio-v2-exports",
]) {
  test(`project-local legacy storage blocks a separate persistent root without mutation: ${old}`, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "studio-upgrade-project-"));
    const dataHome = await mkdtemp(join(tmpdir(), "studio-upgrade-global-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    t.after(() => rm(dataHome, { recursive: true, force: true }));
    const source = join(cwd, old);
    await mkdir(source, { recursive: true, mode: 0o700 });
    await writeFile(join(source, "marker"), "original bytes");
    const root = join(dataHome, "knowledge-studio");
    assert.throws(
      () => checkedStudioPaths(cwd, root),
      /Legacy Studio storage detected.*no data was moved.*docs\/storage-layout.md/s,
    );
    assert.equal(await readFile(join(source, "marker"), "utf8"), "original bytes");
    assert.deepEqual(await readdir(dataHome), []);
  });
}

test("removed V1 JSON storage fails closed without mutation", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "studio-v1-marker-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const root = join(cwd, ".pi", "knowledge-studio");
  const collection = join(root, "collections", "old-json-store");
  await mkdir(collection, { recursive: true, mode: 0o700 });
  await writeFile(join(collection, "collection.json"), "original bytes");
  assert.throws(
    () => checkedStudioPaths(cwd, root),
    /Removed V1 JSON storage detected.*cannot open or migrate it in place.*No data was moved or reindexed/s,
  );
  assert.equal(await readFile(join(collection, "collection.json"), "utf8"), "original bytes");
});

test("selected and project-local legacy symlink roots fail closed", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "studio-symlink-"));
  const dataHome = await mkdtemp(join(tmpdir(), "studio-symlink-global-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  t.after(() => rm(dataHome, { recursive: true, force: true }));
  const target = join(cwd, "target");
  const selectedRoot = join(dataHome, "knowledge-studio");
  await mkdir(target, { mode: 0o700 });
  await symlink(target, selectedRoot);
  assert.throws(() => checkedStudioPaths(cwd, selectedRoot), /Unsafe Studio directory/);

  await rm(selectedRoot);
  const legacyRoot = join(cwd, ".pi", "knowledge-studio-v2");
  await mkdir(join(cwd, ".pi"), { recursive: true, mode: 0o700 });
  await symlink(target, legacyRoot);
  assert.throws(() => checkedStudioPaths(cwd, selectedRoot), /Unsafe Studio directory/);
});

import { lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/** Project defaults only. Standalone APIs with explicit roots remain independent. */
export function studioPaths(cwd: string) {
  const root = resolve(cwd, ".pi", "knowledge-studio");
  return {
    root,
    collections: join(root, "collections"),
    pdfJobs: join(root, "pdf-jobs"),
    pdfGenerations: join(root, "pdf-generations"),
    exports: join(root, "exports"),
    legacyV1: join(root, "legacy-v1"),
  };
}

function stat(path: string) {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Read-only, fail closed even when both old and new stores exist. No migration. */
export function checkedStudioPaths(cwd: string) {
  const paths = studioPaths(cwd);
  const old = [
    [resolve(cwd, ".pi", "knowledge-studio-v2"), paths.collections],
    [resolve(cwd, ".pi", "knowledge-studio-v2-pdf-jobs"), paths.pdfJobs],
    [resolve(cwd, ".pi", "knowledge-studio-v2-pdf-generations"), paths.pdfGenerations],
    [resolve(cwd, "knowledge-studio-v2-exports"), paths.exports],
  ];
  // V1 used this same umbrella, but its JSON collections are incompatible with V2.
  // Never follow symlinks while inspecting the shared prefix.
  for (const path of [resolve(cwd), resolve(cwd, ".pi"), paths.root, paths.collections]) {
    const info = stat(path);
    if (info && (!info.isDirectory() || info.isSymbolicLink()))
      throw new Error(`Unsafe Studio directory: ${path}`);
  }
  const legacy = old.filter(([source]) => stat(source!));
  if (stat(paths.collections)) {
    for (const entry of readdirSync(paths.collections, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`Unsafe Studio collection: ${entry.name}`);
      if (entry.isDirectory() && ["collection.json", "manifest.json"].some(name => stat(join(paths.collections, entry.name, name)))) {
        legacy.push([paths.collections, join(paths.legacyV1, "collections")]);
        break;
      }
    }
  }
  if (legacy.length) throw new Error(
    `Legacy Studio storage detected; no data was moved or reindexed. Stop all Studio processes, back up, and follow docs/storage-layout.md before retrying. Do not merge or overwrite existing destinations.\n${legacy.map(([source, target]) => `${source} -> ${target}`).join("\n")}`,
  );
  return paths;
}

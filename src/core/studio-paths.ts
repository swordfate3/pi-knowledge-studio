import { lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const V2_DATA_DIR_ENV = "PI_KS_V2_DATA_DIR";

/** The V2 store is shared by Pi sessions through the user's persistent ~/.pi area. */
export function defaultStudioRoot(): string {
  const configured = process.env[V2_DATA_DIR_ENV]?.trim();
  if (configured) {
    if (!configured.startsWith("/"))
      throw new Error(`${V2_DATA_DIR_ENV} must be an absolute path`);
    return resolve(configured);
  }
  return join(homedir(), ".pi", "knowledge-studio");
}

/** Explicit roots remain available for tests, migrations, and standalone callers. */
export function studioPaths(_cwd: string, root = defaultStudioRoot()) {
  const resolvedRoot = resolve(root);
  return {
    root: resolvedRoot,
    collections: join(resolvedRoot, "collections"),
    pdfJobs: join(resolvedRoot, "pdf-jobs"),
    pdfGenerations: join(resolvedRoot, "pdf-generations"),
    exports: join(resolvedRoot, "exports"),
    legacyV1: join(resolvedRoot, "legacy-v1"),
  };
}

/** The V1 compatibility store remains project-relative and is intentionally separate. */
export function projectStudioPaths(cwd: string) {
  return studioPaths(cwd, resolve(cwd, ".pi", "knowledge-studio"));
}

function stat(path: string) {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Read-only, fail closed even when both old and new stores exist. No migration. */
export function checkedStudioPaths(cwd: string, root = defaultStudioRoot()) {
  const paths = studioPaths(cwd, root);
  const rootParent = dirname(paths.root);
  const old = [
    [join(rootParent, "knowledge-studio-v2"), paths.collections],
    [join(rootParent, "knowledge-studio-v2-pdf-jobs"), paths.pdfJobs],
    [join(rootParent, "knowledge-studio-v2-pdf-generations"), paths.pdfGenerations],
    [join(dirname(rootParent), "knowledge-studio-v2-exports"), paths.exports],
  ];
  // V1 used this same umbrella, but its JSON collections are incompatible with V2.
  // Never follow symlinks while inspecting the selected persistent root.
  for (const path of [paths.root, paths.collections]) {
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

import { lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const V2_DATA_DIR_ENV = "PI_KS_V2_DATA_DIR";

/** The store is shared by Pi sessions through the user's persistent ~/.pi area. */
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
  };
}

function projectLegacyPaths(cwd: string) {
  const projectRoot = resolve(cwd, ".pi", "knowledge-studio");
  return {
    v1Collections: join(projectRoot, "legacy-v1", "collections"),
    v2Collections: resolve(cwd, ".pi", "knowledge-studio-v2"),
    v2PdfJobs: resolve(cwd, ".pi", "knowledge-studio-v2-pdf-jobs"),
    v2PdfGenerations: resolve(cwd, ".pi", "knowledge-studio-v2-pdf-generations"),
    v2Exports: resolve(cwd, "knowledge-studio-v2-exports"),
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
export function checkedStudioPaths(cwd: string, root = defaultStudioRoot()) {
  const paths = studioPaths(cwd, root);
  const projectLegacy = projectLegacyPaths(cwd);
  const old: Array<[string, string]> = [
    [projectLegacy.v1Collections, paths.collections],
    [projectLegacy.v2Collections, paths.collections],
    [projectLegacy.v2PdfJobs, paths.pdfJobs],
    [projectLegacy.v2PdfGenerations, paths.pdfGenerations],
    [projectLegacy.v2Exports, paths.exports],
  ];
  // Never follow symlinks while inspecting selected or legacy persistent roots.
  for (const path of [paths.root, paths.collections, ...old.map(([source]) => source)]) {
    const info = stat(path);
    if (info?.isSymbolicLink()) throw new Error(`Unsafe Studio directory: ${path}`);
    if (info && !info.isDirectory()) throw new Error(`Unsafe Studio directory: ${path}`);
  }
  const legacy = old.filter(([source]) => stat(source));
  if (stat(paths.collections)) {
    for (const entry of readdirSync(paths.collections, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`Unsafe Studio collection: ${entry.name}`);
      if (entry.isDirectory() && ["collection.json", "manifest.json"].some(name => stat(join(paths.collections, entry.name, name)))) {
        throw new Error(
          `Removed V1 JSON storage detected at ${paths.collections}; the current Studio cannot open or migrate it in place. Stop all Studio processes, back it up, and use the old release to export needed data before removing that directory. No data was moved or reindexed.`,
        );
      }
    }
  }
  if (legacy.length) throw new Error(
    `Legacy Studio storage detected; no data was moved or reindexed. Stop all Studio processes, back up, and follow docs/storage-layout.md before retrying. Do not merge or overwrite existing destinations.\n${legacy.map(([source, target]) => `${source} -> ${target}`).join("\n")}`,
  );
  return paths;
}

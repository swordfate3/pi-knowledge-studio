import { rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
// @ts-ignore TS2691: Pi loads the TypeScript extension source through its Jiti loader.
import {
  ensureDirectorySafe,
  readRegularFile,
  withSafeDirectory,
} from "../core/path-safety.ts";
// @ts-ignore TS2691: Pi loads the TypeScript extension source through its Jiti loader.
import type {
  AnnotationRecord,
  AssetRecord,
  ChunkRecord,
  CollectionData,
  CollectionManifest,
  DocumentRecord,
} from "../core/types.ts";

const MAX_COLLECTION_BYTES = 100 * 1024 * 1024;

const EMPTY_DATA = (name: string, profile: string): CollectionData => {
  const now = new Date().toISOString();
  const manifest: CollectionManifest = {
    schemaVersion: 1,
    name,
    profile,
    createdAt: now,
    updatedAt: now,
    documentCount: 0,
    chunkCount: 0,
    assetCount: 0,
    annotationCount: 0,
  };
  return { manifest, documents: [], chunks: [], assets: [], annotations: [] };
};

export function collectionKey(name: string): string {
  const normalized = name
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized || normalized === "." || normalized === "..")
    throw new Error(
      "Collection name must contain at least one safe character.",
    );
  return normalized.slice(0, 96);
}

export function collectionDirectory(root: string, name: string): string {
  return join(root, "collections", collectionKey(name));
}

async function writeJsonAtomic(
  root: string,
  path: string,
  value: unknown,
): Promise<void> {
  const directory = dirname(path);
  await ensureDirectorySafe(directory);
  await withSafeDirectory(root, directory, async (stableDirectory: string) => {
    const fileName = basename(path);
    const temporary = join(
      stableDirectory,
      `.${fileName}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    const destination = join(stableDirectory, fileName);
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, destination);
    } catch (error) {
      await import("node:fs/promises").then(({ unlink }) =>
        unlink(temporary).catch(() => undefined),
      );
      throw error;
    }
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isMetadata(value: unknown): value is Record<string, unknown> {
  return isObject(value);
}

function isLocator(
  value: unknown,
): value is DocumentRecord["metadata"] & { sourceUri: string } {
  if (!isObject(value) || !isNonEmptyString(value.sourceUri)) return false;
  if (value.page !== undefined && !isPositiveSafeInteger(value.page))
    return false;
  if (value.lineStart !== undefined && !isPositiveSafeInteger(value.lineStart))
    return false;
  if (value.lineEnd !== undefined && !isPositiveSafeInteger(value.lineEnd))
    return false;
  if (
    value.sectionPath !== undefined &&
    (!Array.isArray(value.sectionPath) ||
      !value.sectionPath.every(isNonEmptyString))
  )
    return false;
  return value.fragment === undefined || typeof value.fragment === "string";
}

function isDocumentRecord(
  value: unknown,
  collection: string,
): value is DocumentRecord {
  return (
    isObject(value) &&
    isNonEmptyString(value.id) &&
    value.collection === collection &&
    isNonEmptyString(value.sourceUri) &&
    isNonEmptyString(value.title) &&
    isNonEmptyString(value.mimeType) &&
    isNonEmptyString(value.sha256) &&
    isNonEmptyString(value.importedAt) &&
    isNonEmptyString(value.profile) &&
    isMetadata(value.metadata)
  );
}

function isChunkRecord(
  value: unknown,
  collection: string,
): value is ChunkRecord {
  return (
    isObject(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.documentId) &&
    value.collection === collection &&
    typeof value.ordinal === "number" &&
    Number.isSafeInteger(value.ordinal) &&
    value.ordinal >= 0 &&
    typeof value.text === "string" &&
    isLocator(value.locator) &&
    isMetadata(value.metadata)
  );
}

function isAssetRecord(
  value: unknown,
  collection: string,
): value is AssetRecord {
  const kinds = new Set(["image", "page", "table", "audio", "video", "other"]);
  return (
    isObject(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.documentId) &&
    value.collection === collection &&
    typeof value.kind === "string" &&
    kinds.has(value.kind) &&
    isNonEmptyString(value.sourceUri) &&
    isNonEmptyString(value.storedPath) &&
    isNonEmptyString(value.mimeType) &&
    isNonEmptyString(value.sha256) &&
    isLocator(value.locator) &&
    (value.title === undefined || typeof value.title === "string") &&
    (value.caption === undefined || typeof value.caption === "string") &&
    (value.ocrText === undefined || typeof value.ocrText === "string") &&
    isMetadata(value.metadata)
  );
}

function isAnnotationRecord(
  value: unknown,
  collection: string,
): value is AnnotationRecord {
  const types = new Set(["ocr", "caption", "vision", "manual"]);
  return (
    isObject(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.assetId) &&
    value.collection === collection &&
    typeof value.type === "string" &&
    types.has(value.type) &&
    typeof value.text === "string" &&
    (value.model === undefined || typeof value.model === "string") &&
    isNonEmptyString(value.createdAt) &&
    isMetadata(value.metadata)
  );
}

function uniqueIds(records: readonly { id: string }[]): boolean {
  return new Set(records.map((record) => record.id)).size === records.length;
}

function validateCollection(
  value: unknown,
  requestedName: string,
): CollectionData {
  if (!isObject(value) || !isObject(value.manifest))
    throw new Error("Collection file is not a valid object.");
  const name = collectionKey(requestedName);
  const manifest = value.manifest;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.name !== name ||
    !isNonEmptyString(manifest.profile) ||
    !isNonEmptyString(manifest.createdAt) ||
    !isNonEmptyString(manifest.updatedAt)
  )
    throw new Error(
      "Collection manifest has an invalid name or schema version.",
    );
  const arrays = ["documents", "chunks", "assets", "annotations"] as const;
  if (arrays.some((key) => !Array.isArray(value[key])))
    throw new Error("Collection file has an invalid schema.");
  const documents = value.documents as unknown[];
  const chunks = value.chunks as unknown[];
  const assets = value.assets as unknown[];
  const annotations = value.annotations as unknown[];
  if (
    !documents.every((item) => isDocumentRecord(item, name)) ||
    !chunks.every((item) => isChunkRecord(item, name)) ||
    !assets.every((item) => isAssetRecord(item, name)) ||
    !annotations.every((item) => isAnnotationRecord(item, name))
  )
    throw new Error("Collection contains invalid or foreign records.");
  const typedDocuments = documents as DocumentRecord[];
  const typedChunks = chunks as ChunkRecord[];
  const typedAssets = assets as AssetRecord[];
  const typedAnnotations = annotations as AnnotationRecord[];
  if (
    !uniqueIds(typedDocuments) ||
    !uniqueIds(typedChunks) ||
    !uniqueIds(typedAssets) ||
    !uniqueIds(typedAnnotations)
  )
    throw new Error("Collection contains duplicate record IDs.");
  const documentIds = new Set(typedDocuments.map((item) => item.id));
  const assetIds = new Set(typedAssets.map((item) => item.id));
  if (
    typedChunks.some((item) => !documentIds.has(item.documentId)) ||
    typedAssets.some((item) => !documentIds.has(item.documentId)) ||
    typedAnnotations.some((item) => !assetIds.has(item.assetId))
  )
    throw new Error("Collection contains records with missing references.");
  // SAFETY: manifest fields were validated above and the collection schema version is exactly 1.
  return {
    manifest: manifest as unknown as CollectionManifest,
    documents: typedDocuments,
    chunks: typedChunks,
    assets: typedAssets,
    annotations: typedAnnotations,
  };
}

export async function loadCollection(
  root: string,
  name: string,
  profile = "general",
): Promise<CollectionData> {
  const directory = collectionDirectory(root, name);
  try {
    return await withSafeDirectory(
      root,
      directory,
      async (stableDirectory: string) => {
        const raw = (
          await readRegularFile(
            join(stableDirectory, "collection.json"),
            MAX_COLLECTION_BYTES,
          )
        ).toString("utf8");
        return validateCollection(JSON.parse(raw) as unknown, name);
      },
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return EMPTY_DATA(name, profile);
    throw error;
  }
}

export async function saveCollection(
  root: string,
  data: CollectionData,
): Promise<void> {
  const updated: CollectionData = {
    ...data,
    manifest: {
      ...data.manifest,
      updatedAt: new Date().toISOString(),
      documentCount: data.documents.length,
      chunkCount: data.chunks.length,
      assetCount: data.assets.length,
      annotationCount: data.annotations.length,
      name: collectionKey(data.manifest.name),
    },
  };
  validateCollection(updated, updated.manifest.name);
  await ensureDirectorySafe(join(root, "collections"));
  await ensureDirectorySafe(collectionDirectory(root, updated.manifest.name));
  await writeJsonAtomic(
    root,
    join(collectionDirectory(root, updated.manifest.name), "collection.json"),
    updated,
  );
  await writeJsonAtomic(
    root,
    join(collectionDirectory(root, updated.manifest.name), "manifest.json"),
    updated.manifest,
  );
}

export async function saveManifest(
  root: string,
  data: CollectionData,
): Promise<void> {
  const manifest: CollectionManifest = {
    ...data.manifest,
    name: collectionKey(data.manifest.name),
    documentCount: data.documents.length,
    chunkCount: data.chunks.length,
    assetCount: data.assets.length,
    annotationCount: data.annotations.length,
    updatedAt: new Date().toISOString(),
  };
  await ensureDirectorySafe(join(root, "collections"));
  await ensureDirectorySafe(collectionDirectory(root, manifest.name));
  await writeJsonAtomic(
    root,
    join(collectionDirectory(root, manifest.name), "manifest.json"),
    manifest,
  );
}

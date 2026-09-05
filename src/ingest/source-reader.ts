import { constants } from "node:fs";
import { access, lstat, open } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
// @ts-ignore TS2691: Pi loads the TypeScript extension source through its Jiti loader.
import { createChunks } from "../core/chunking.ts";
// @ts-ignore TS2691: Pi loads the TypeScript extension source through its Jiti loader.
import { sha256Bytes, stableId } from "../core/provenance.ts";
// @ts-ignore TS2691: Pi loads the TypeScript extension source through its Jiti loader.
import type {
  AssetRecord,
  DocumentRecord,
  IngestResult,
  Locator,
} from "../core/types.ts";
// @ts-ignore TS2691: Pi loads the TypeScript extension source through its Jiti loader.
import {
  collectionDirectory,
  collectionKey,
  loadCollection,
  saveCollection,
} from "../storage/store.ts";
// @ts-ignore TS2691: Pi loads the TypeScript extension source through its Jiti loader.
import type { StudioConfig } from "../config.ts";
// @ts-ignore TS2691: Pi loads the TypeScript extension source through its Jiti loader.
import {
  ensureDirectorySafe,
  readRegularFile,
  readRegularFileWithin,
  realpathWithin,
  safeRelativeResource,
  withSafeDirectory,
} from "../core/path-safety.ts";

interface RawSource {
  path: string;
  text: string;
  mimeType: string;
  assets: Array<{
    sourcePath: string;
    kind: AssetRecord["kind"];
    locator: Locator;
    title?: string;
  }>;
  warnings: string[];
}

const MIME_TYPES: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".rst": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
};

function mimeType(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function stripMarkup(text: string, type: string): string {
  if (type === "text/html")
    return text
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ");
  return text;
}

function extractMarkdownAssets(
  sourcePath: string,
  text: string,
): RawSource["assets"] {
  const assets: RawSource["assets"] = [];
  const pattern = /!\[([^\]]*)\]\(([^\s)]+)(?:\s+['"][^'"]*['"])?\)/g;
  for (const match of text.matchAll(pattern)) {
    const target = match[2];
    const resourcePath = target
      ? safeRelativeResource(resolve(sourcePath, ".."), target)
      : undefined;
    if (!resourcePath) continue;
    assets.push({
      sourcePath: resourcePath,
      kind: "image",
      locator: {
        sourceUri: sourcePath,
        ...(target ? { fragment: target } : {}),
      },
      ...(match[1] ? { title: match[1] } : {}),
    });
  }
  return assets;
}

function extractHtmlAssets(
  sourcePath: string,
  text: string,
): RawSource["assets"] {
  const assets: RawSource["assets"] = [];
  const pattern = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (const match of text.matchAll(pattern)) {
    const target = match[1];
    const resourcePath = target
      ? safeRelativeResource(resolve(sourcePath, ".."), target)
      : undefined;
    if (!resourcePath) continue;
    assets.push({
      sourcePath: resourcePath,
      kind: "image",
      locator: {
        sourceUri: sourcePath,
        ...(target ? { fragment: target } : {}),
      },
    });
  }
  return assets;
}

interface PdfTextItem {
  str?: unknown;
  hasEOL?: unknown;
}

interface PdfPageProxy {
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
}

interface PdfDocumentProxy {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageProxy>;
  destroy(): Promise<void>;
}

interface PdfModule {
  getDocumentProxy(
    data: Uint8Array,
    options?: { maxImageSize?: number },
  ): Promise<PdfDocumentProxy>;
}

async function readPdf(
  path: string,
  bytes: Uint8Array,
  maxPages: number,
  maxImagePixels: number,
  maxTextChars: number,
  maxExtractionMs: number,
): Promise<{ text: string; warnings: string[] }> {
  let document: PdfDocumentProxy | undefined;
  try {
    const moduleName = "unpdf";
    // SAFETY: unpdf exposes getDocumentProxy with the runtime shape declared by PdfModule.
    const pdf = (await import(moduleName)) as unknown as PdfModule;
    document = await withTimeout(
      pdf.getDocumentProxy(bytes, { maxImageSize: maxImagePixels }),
      maxExtractionMs,
      "PDF loading",
    );
    if (
      !Number.isSafeInteger(document.numPages) ||
      document.numPages < 1 ||
      document.numPages > maxPages
    )
      throw new Error(
        `PDF has ${document.numPages} pages; maximum is ${maxPages}.`,
      );

    const pages: string[] = [];
    let totalChars = 0;
    const deadline = Date.now() + maxExtractionMs;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0)
        throw new Error(
          `PDF extraction exceeded the ${maxExtractionMs}-ms limit.`,
        );
      const page = await withTimeout(
        document.getPage(pageNumber),
        remainingMs,
        `PDF page ${pageNumber} loading`,
      );
      const content = await withTimeout(
        page.getTextContent(),
        Math.max(1, deadline - Date.now()),
        `PDF page ${pageNumber} text extraction`,
      );
      const pageText = content.items
        .map((item) =>
          typeof item.str === "string"
            ? item.str + (item.hasEOL === true ? "\n" : "")
            : "",
        )
        .join("");
      totalChars += pageText.length;
      if (totalChars > maxTextChars)
        throw new Error(
          `PDF extracted text exceeds the ${maxTextChars}-character limit.`,
        );
      pages.push(pageText);
    }
    return { text: pages.join("\n\n"), warnings: [] };
  } catch (error) {
    return {
      text: "",
      warnings: [
        `PDF text extraction unavailable for ${path}: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  } finally {
    await document?.destroy().catch(() => undefined);
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error("PDF extraction timeout is not configured correctly.");
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`${operation} exceeded the configured timeout.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readSource(
  path: string,
  bytes: Uint8Array,
  config: StudioConfig,
): Promise<RawSource> {
  const type = mimeType(path);
  if (type === "application/pdf") {
    const pdf = await readPdf(
      path,
      bytes,
      config.maxPdfPages,
      config.maxPdfImagePixels,
      config.maxExtractedTextChars,
      config.maxPdfExtractionMs,
    );
    return {
      path,
      text: pdf.text,
      mimeType: type,
      assets: [],
      warnings: pdf.warnings,
    };
  }
  const raw = Buffer.from(bytes).toString("utf8");
  const text = stripMarkup(raw, type);
  const assets =
    type === "text/markdown"
      ? extractMarkdownAssets(path, raw)
      : type === "text/html"
        ? extractHtmlAssets(path, raw)
        : [];
  return {
    path,
    text,
    mimeType: type === "application/octet-stream" ? "text/plain" : type,
    assets,
    warnings: [],
  };
}

async function collectFiles(input: string): Promise<string[]> {
  const info = await lstat(input);
  if (info.isSymbolicLink())
    throw new Error(`Symlink sources are not allowed: ${input}`);
  if (info.isFile()) return [input];
  if (!info.isDirectory())
    throw new Error(`Source is not a regular file or directory: ${input}`);
  const result: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await (await import("node:fs/promises")).readdir(
      directory,
      { withFileTypes: true },
    );
    for (const entry of entries) {
      if (
        entry.name.startsWith(".") ||
        ["node_modules", "dist", "build", "coverage"].includes(entry.name)
      )
        continue;
      const next = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(next);
      else if (entry.isFile() && MIME_TYPES[extname(next).toLowerCase()])
        result.push(next);
    }
  };
  await visit(input);
  return result.sort();
}

function relativeAssetPath(root: string, asset: string): string {
  const rel = relative(resolve(root), asset);
  if (!rel || rel.startsWith("..") || rel.includes("\0") || rel.startsWith("/"))
    throw new Error(`Asset destination is outside the data root: ${asset}`);
  return rel.split("\\").join("/");
}

async function writeAssetIfAbsent(
  root: string,
  destination: string,
  bytes: Uint8Array,
  expectedHash: string,
): Promise<void> {
  const directory = dirname(destination);
  await withSafeDirectory(root, directory, async (stableDirectory: string) => {
    const stableDestination = join(stableDirectory, basename(destination));
    const flags =
      constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0);
    try {
      const handle = await open(stableDestination, flags, 0o600);
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
    }

    const existingHash = sha256Bytes(
      await readRegularFile(stableDestination, bytes.byteLength),
    );
    if (existingHash !== expectedHash)
      throw new Error(
        `Asset destination already contains different bytes: ${destination}`,
      );
  });
}

export async function ingestSource(
  root: string,
  collection: string,
  profile: string,
  input: string,
  config: StudioConfig,
): Promise<IngestResult[]> {
  const collectionName = collectionKey(collection);
  const inputPath = resolve(input);
  await access(inputPath);
  const inputInfo = await lstat(inputPath);
  if (inputInfo.isSymbolicLink())
    throw new Error(`Symlink sources are not allowed: ${input}`);
  const sourceRoot = inputInfo.isDirectory()
    ? await realpathWithin(inputPath, inputPath)
    : await realpathWithin(resolve(inputPath, ".."), resolve(inputPath, ".."));
  const results: IngestResult[] = [];
  for (const path of await collectFiles(inputPath)) {
    const bytes = await readRegularFileWithin(
      sourceRoot,
      path,
      config.maxSourceBytes,
    );
    const safePath = resolve(path);
    const source = await readSource(safePath, bytes, config);
    const sourceHash = sha256Bytes(bytes);
    const documentId = stableId(collectionName, path, sourceHash);
    const document: DocumentRecord = {
      id: documentId,
      collection: collectionName,
      sourceUri: path,
      title: basename(path, extname(path)),
      mimeType: source.mimeType,
      sha256: sourceHash,
      importedAt: new Date().toISOString(),
      profile,
      metadata: {},
    };
    const locator: Locator = { sourceUri: path };
    const chunks = createChunks(
      documentId,
      collectionName,
      source.text,
      locator,
      config.maxChunkChars,
      config.chunkOverlapChars,
    );
    const data = await loadCollection(root, collectionName, profile);
    const assets: AssetRecord[] = [];
    const seenAssetIds = new Set<string>();
    const assetDir = join(collectionDirectory(root, collectionName), "assets");
    await ensureDirectorySafe(assetDir);
    for (const asset of source.assets) {
      try {
        const safeAssetPath = resolve(asset.sourcePath);
        const assetBytes = await readRegularFileWithin(
          sourceRoot,
          safeAssetPath,
          config.maxAssetBytes,
        );
        if (assetBytes.byteLength > config.maxAssetBytes) {
          source.warnings.push(`Skipped oversized asset: ${asset.sourcePath}`);
          continue;
        }
        const hash = sha256Bytes(assetBytes);
        const extension = extname(safeAssetPath).toLowerCase() || ".bin";
        const assetId = stableId(documentId, "asset", asset.sourcePath, hash);
        if (seenAssetIds.has(assetId)) continue;
        const filename = `${assetId}${extension}`;
        const destination = join(assetDir, filename);
        await writeAssetIfAbsent(root, destination, assetBytes, hash);
        seenAssetIds.add(assetId);
        assets.push({
          id: assetId,
          documentId,
          collection: collectionName,
          kind: asset.kind,
          sourceUri: asset.sourcePath,
          storedPath: relativeAssetPath(root, destination),
          mimeType: mimeType(safeAssetPath),
          sha256: hash,
          locator: asset.locator,
          ...(asset.title ? { title: asset.title } : {}),
          metadata: {},
        });
      } catch (error) {
        source.warnings.push(
          `Skipped missing asset ${asset.sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    data.documents = data.documents
      .filter((item: DocumentRecord) => item.id !== documentId)
      .concat(document);
    data.chunks = data.chunks
      .filter((item: { documentId: string }) => item.documentId !== documentId)
      .concat(chunks);
    data.assets = data.assets
      .filter((item: AssetRecord) => item.documentId !== documentId)
      .concat(assets);
    await saveCollection(root, data);
    results.push({
      collection: collectionName,
      document,
      chunks,
      assets,
      warnings: source.warnings,
    });
  }
  return results;
}

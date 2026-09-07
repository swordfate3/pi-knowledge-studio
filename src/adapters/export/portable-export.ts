import { verifyOcrRender } from "../../application/verify-ocr-artifacts.ts";
import { OCR_WARNING, verifyOcrText } from "../../domain/ocr.ts";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  EvidenceBundle,
  ExportPermission,
  IllustratedDocument,
  Locator,
} from "../../domain/evidence.ts";
import type { BlobStore } from "../../ports/blob-store.ts";
import { validateEvidence } from "../../application/validate-evidence.ts";
import { withSafeDirectory } from "../../core/path-safety.ts";
import { verifiedDisplay } from "../parsing/capture-image.ts";

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}

/** Entities prevent user text from creating Markdown links, HTML or block syntax. */
function escapeMarkdown(value: string): string {
  return value.replace(
    /[^\p{L}\p{N} ]/gu,
    (char) => `&#${char.codePointAt(0)};`,
  );
}

function publicLocator(locator: Locator): Locator {
  if (locator.kind === "page") return { kind: "page", page: locator.page };
  if (locator.kind === "lines")
    return { kind: "lines", start: locator.start, end: locator.end };
  return { kind: "anchor", anchor: locator.anchor };
}

function locatorLabel(locator: Locator): string {
  if (locator.kind === "page") return `page ${locator.page}`;
  if (locator.kind === "lines") return `lines ${locator.start}–${locator.end}`;
  return locator.anchor;
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Internal package builder: filenames are entirely host-generated. */
async function buildPackage(
  inputBundle: EvidenceBundle,
  inputDocument: IllustratedDocument,
  inputPermission: ExportPermission,
  blobs: BlobStore,
): Promise<Map<string, Uint8Array>> {
  // Copy before the first await: caller mutations cannot alter an in-flight export.
  const bundle = structuredClone(inputBundle);
  const document = structuredClone(inputDocument);
  const permission = structuredClone(inputPermission);
  validateEvidence(bundle, document);
  if (permission.documentContent !== true)
    throw new Error("Document content sharing was not approved");
  const files = new Map<string, Uint8Array>();
  const textIds = new Set(
    document.blocks.flatMap((block) => block.evidenceIds),
  );
  const imageIds = new Set(
    document.blocks.flatMap((block) =>
      block.kind === "figure" ? [block.occurrenceId] : [],
    ),
  );
  if (imageIds.size && permission.images !== true)
    throw new Error("Image sharing was not approved");
  const texts = bundle.texts.filter((item) => textIds.has(item.id));
  // Required OCR renders travel with cited transcripts, even if a model omits figure blocks.
  for (const text of texts)
    if (text.provenance) {
      await verifyOcrText(text.text, text.provenance, blobs, text.start);
      const image = bundle.images.find(
        (i) =>
          i.sourceId === text.sourceId &&
          i.blobHash === text.provenance!.pageRenderHash &&
          i.locator.kind === "page" &&
          i.locator.page === text.provenance!.page &&
          i.provenance?.transcriptHash === text.provenance!.transcriptHash &&
          i.provenance.sourceHash === text.provenance!.sourceHash &&
          i.provenance.page === text.provenance!.page &&
          i.provenance.stackFingerprint === text.provenance!.stackFingerprint &&
          i.provenance.pageCount === text.provenance!.pageCount &&
          i.provenance.width === text.provenance!.width &&
          i.provenance.height === text.provenance!.height &&
          i.provenance.recipeFingerprint === text.provenance!.recipeFingerprint,
      )!;
      imageIds.add(image.id);
    }
  if (imageIds.size && permission.images !== true)
    throw new Error("Image sharing was not approved");
  const images = bundle.images.filter((item) => imageIds.has(item.id));
  const sourceIds = new Set([...texts, ...images].map((item) => item.sourceId));
  const sources = bundle.sources.filter((source) => sourceIds.has(source.id));
  let totalBytes = 0;
  const deadline = Date.now() + 60_000;
  const addAsset = (path: string, bytes: Uint8Array) => {
    if (files.has(path)) return;
    totalBytes += bytes.length;
    if (totalBytes > 50 * 1024 * 1024)
      throw new Error("Export image budget exceeded");
    files.set(path, bytes);
  };
  const verified = new Set<string>();
  for (const image of images) {
    if (Date.now() > deadline)
      throw new Error("Export image deadline exceeded");
    // Geometry belongs to each occurrence, not to the deduplicated asset.
    if (image.provenance) await verifyOcrRender(image.provenance, blobs);
    const identity = JSON.stringify([image.blobHash, image.rendition ?? null]);
    if (verified.has(identity)) continue;
    verified.add(identity);
    const prepared = await verifiedDisplay(image, blobs);
    const extension = image.rendition
      ? image.rendition.sourceMediaType === "image/jpeg"
        ? "jpg"
        : "webp"
      : "png";
    addAsset(`assets/${image.blobHash}.${extension}`, prepared.original);
    if (image.rendition)
      addAsset(`assets/${image.rendition.blobHash}.png`, prepared.display);
  }
  const mode =
    permission.excerpts === true ? "excerpt-evidence" : "provenance-only";
  const notice = `${[...texts, ...images].some((item) => item.provenance) ? OCR_WARNING + " " : ""}${document.mode} | ${mode}. References do not prove semantic support or source authenticity.`;
  const html = [
    `<h1>${escapeHtml(document.title)}</h1>`,
    `<p>${escapeHtml(notice)}</p>`,
  ];
  const markdown = [
    `# ${escapeMarkdown(document.title)}`,
    escapeMarkdown(notice),
  ];
  for (const block of document.blocks) {
    const refsHtml = block.evidenceIds
      .map((id) => `<a href="#${id}">[${id}]</a>`)
      .join(" ");
    const refsMd = block.evidenceIds.map((id) => `[${id}]`).join(" ");
    if (
      block.evidenceIds.some((id) => texts.find((t) => t.id === id)?.provenance)
    ) {
      html.push(`<p>${escapeHtml(OCR_WARNING)}</p>`);
      markdown.push(escapeMarkdown(OCR_WARNING));
    }
    if (block.kind === "paragraph") {
      html.push(`<p>${escapeHtml(block.text)} ${refsHtml}</p>`);
      markdown.push(`${escapeMarkdown(block.text)} ${refsMd}`);
    } else {
      const image = images.find((item) => item.id === block.occurrenceId)!;
      const path = `assets/${image.rendition?.blobHash ?? image.blobHash}.png`;
      const label = `${image.provenance ? OCR_WARNING + " " : ""}${block.caption} [${image.id}; ${image.originKind}; ${image.sourceId}; ${locatorLabel(image.locator)}]`;
      html.push(
        `<figure><img src="${path}" alt="${escapeHtml(block.caption)}"><figcaption>${escapeHtml(label)} ${refsHtml}</figcaption></figure>`,
      );
      markdown.push(
        `![${escapeMarkdown(block.caption)}](${path})\n\n${escapeMarkdown(label)} ${refsMd}`,
      );
    }
  }
  html.push("<h2>Evidence and sources</h2>");
  markdown.push("## Evidence and sources");
  for (const item of texts) {
    const source = sources.find((entry) => entry.id === item.sourceId)!;
    const label = `${item.provenance ? OCR_WARNING + " " : ""}${item.id}: ${source.label}; ${locatorLabel(item.locator)}`;
    html.push(
      `<section id="${item.id}"><p>${escapeHtml(label)}</p>${permission.excerpts === true ? `<${item.provenance ? "pre" : "blockquote"}>${escapeHtml(item.text)}</${item.provenance ? "pre" : "blockquote"}>` : ""}</section>`,
    );
    markdown.push(
      `${escapeMarkdown(label)}${permission.excerpts === true ? `\n\n${item.provenance ? "OCR transcript: " : "> "}${escapeMarkdown(item.text)}` : ""}`,
    );
  }
  const addText = (name: string, value: string) =>
    files.set(name, Buffer.from(value));
  addText("document.md", markdown.join("\n\n") + "\n");
  addText(
    "document.html",
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(document.title)}</title></head><body>${html.join("\n")}</body></html>`,
  );
  // Explicit projections: unknown parser/provider fields never leak into the package.
  addText(
    "sources.json",
    JSON.stringify(
      {
        schemaVersion: 1,
        bundleId: bundle.id,
        snapshotId: bundle.snapshotId,
        mode,
        sources: sources.map((source) => ({
          id: source.id,
          label: source.label,
          revisionHash: source.revisionHash,
        })),
        occurrences: images.map((image) => ({
          id: image.id,
          sourceId: image.sourceId,
          locator: publicLocator(image.locator),
          originKind: image.originKind,
          ...(image.provenance ? { provenance: image.provenance } : {}),
          blobHash: image.blobHash,
          path: `assets/${image.blobHash}.${image.rendition ? (image.rendition.sourceMediaType === "image/jpeg" ? "jpg" : "webp") : "png"}`,
          ...(image.rendition
            ? {
                mediaType: image.rendition.sourceMediaType,
                rendition: {
                  ...image.rendition,
                  path: `assets/${image.rendition.blobHash}.png`,
                  derived: true,
                },
              }
            : {}),
        })),
      },
      null,
      2,
    ),
  );
  addText(
    "evidence.json",
    JSON.stringify(
      {
        schemaVersion: 1,
        mode,
        excerpts: texts.map((item) => ({
          id: item.id,
          sourceId: item.sourceId,
          elementId: item.elementId,
          locator: publicLocator(item.locator),
          start: item.start,
          end: item.end,
          offsetUnit: "utf16-code-unit",
          textHash: item.textHash,
          ...(item.provenance ? { provenance: item.provenance } : {}),
          ...(permission.excerpts === true ? { text: item.text } : {}),
        })),
      },
      null,
      2,
    ),
  );
  addText(
    "manifest.json",
    JSON.stringify(
      {
        schemaVersion: 1,
        files: [...files].map(([path, bytes]) => ({
          path,
          sha256: hash(bytes),
          byteLength: bytes.length,
        })),
      },
      null,
      2,
    ),
  );
  return files;
}

/**
 * Export to a new host-named child of an EXISTING, explicitly approved directory.
 * No overwrites, no model-specified paths, no automatic access to v1 storage.
 * Staging + rename provides atomic visibility, not a power-loss durability guarantee.
 */
export async function exportPortableDocument(
  outputRoot: string,
  bundle: EvidenceBundle,
  document: IllustratedDocument,
  permission: ExportPermission,
  blobs: BlobStore,
): Promise<string> {
  const files = await buildPackage(bundle, document, permission, blobs);
  const name = `document-${randomUUID()}`;
  await withSafeDirectory(outputRoot, outputRoot, async (directory) => {
    const info = await stat(directory);
    if (
      process.platform !== "win32" &&
      ((info.mode & 0o022) !== 0 || info.uid !== process.getuid?.())
    )
      throw new Error(
        "Export root must be owned by the current user and not writable by group/others",
      );
    const staging = join(directory, `.staging-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    try {
      await mkdir(join(staging, "assets"), { mode: 0o700 });
      for (const [path, bytes] of files) {
        await writeFile(join(staging, path), bytes, {
          flag: "wx",
          mode: 0o600,
        });
      }
      await rename(staging, join(directory, name));
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  });
  return join(outputRoot, name);
}

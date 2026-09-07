import { verifyOcrRender } from "../../application/verify-ocr-artifacts.ts";
import { captureOcrPdf, effectiveOcrSignal, type OcrOptions } from "./local-pdf-ocr.ts";
import { verifyOcrText } from "../../domain/ocr.ts";
import { basename, dirname, extname, resolve } from "node:path";
import {
  readRegularFileWithin,
  safeRelativeResource,
} from "../../core/path-safety.ts";
import { sha256 } from "../blob/file-blob-store.ts";
import { prepareImage, type PreparedImage } from "./capture-image.ts";
import { validateCapture } from "../../application/validate-capture.ts";
import { capturePdf } from "./capture-pdf.ts";
import { captureDocx } from "./capture-docx.ts";
import type { BlobStore } from "../../ports/blob-store.ts";
import type {
  CapturedDocument,
  CapturedElement,
  CapturedImage,
} from "../../domain/retrieval.ts";

import { captureHtml, type ValidateSourcePath } from "./capture-html.ts";

const PARSER = "local-text-png-pdf-v2";
/** Restricted Markdown: inline local PNG/JPEG/WebP images; no HTML, URL fetch, or code execution. */
export async function captureLocal(
  sourceRoot: string,
  path: string,
  blobs: BlobStore,
  validatePath: ValidateSourcePath = () => {},
  options: { ocr?: OcrOptions; signal?: AbortSignal } = {},
): Promise<CapturedDocument> {
  options = { ...options, ...(options.ocr ? { ocr: { ...options.ocr } } : {}) };
  const signal = effectiveOcrSignal(options.signal, options.ocr?.signal);
  signal?.throwIfAborted();
  const absolute = resolve(path);
  await validatePath(absolute);
  const bytes = await readRegularFileWithin(
    sourceRoot,
    absolute,
    20 * 1024 * 1024,
  );
  const extension = extname(absolute).toLowerCase();
  if (
    ![
      ".txt",
      ".md",
      ".markdown",
      ".png",
      ".jpg",
      ".jpeg",
      ".webp",
      ".pdf",
      ".docx",
      ".html",
      ".htm",
    ].includes(extension)
  )
    throw new Error(
      "Unsupported format: use TXT, restricted Markdown/DOCX/HTML, digital PDF or validated PNG/JPEG/static WebP",
    );
  if (options.ocr && extension !== ".pdf")
    throw new Error("OCR_UNAVAILABLE: OCR requires PDF");
  const pending = new Map<string, Uint8Array>();
  let pendingBytes = 0;
  const stage: BlobStore = {
    async put(data) {
      const hash = sha256(data);
      if (!pending.has(hash)) {
        pendingBytes += data.length;
        if (pendingBytes > 70 * 1024 * 1024)
          throw new Error("Document image byte budget exceeded");
        pending.set(hash, data.slice());
      }
      return hash;
    },
    async get(hash) {
      const data = pending.get(hash);
      if (!data) throw new Error("Missing staged blob");
      return data;
    },
  };
  const deadline = Date.now() + (options.ocr ? 130_000 : extension === ".pdf" ? 120_000 : 60_000);
  let pixels = 0;
  const stageImage = async (
    data: Uint8Array,
    ext: string,
  ): Promise<PreparedImage> => {
    if (Date.now() > deadline)
      throw new Error("Document image deadline exceeded");
    const prepared = await prepareImage(data, ext);
    if (prepared.rendition) {
      pixels += prepared.rendition.width * prepared.rendition.height;
      if (pixels > 16_000_000)
        throw new Error("Document image pixel budget exceeded");
      await stage.put(prepared.display);
    }
    await stage.put(data);
    return prepared;
  };
  const sourceHash = await stage.put(bytes);
  const elements: CapturedElement[] = [];
  const images: CapturedImage[] = [];
  let parserVersion = extension === ".docx" ? "restricted-docx-png-v1" : PARSER;
  if ([".html", ".htm"].includes(extension)) {
    parserVersion = "restricted-static-html-v1";
    const parsed = await captureHtml(
      bytes,
      sourceRoot,
      absolute,
      stage,
      validatePath,
    );
    elements.push(...parsed.elements);
    images.push(...parsed.images);
  } else if (extension === ".docx") {
    const parsed = await captureDocx(bytes, stage);
    elements.push(...parsed.elements);
    images.push(...parsed.images);
  } else if (extension === ".pdf") {
    const parsed = options.ocr
      ? await captureOcrPdf(bytes, stage, {
          ...options.ocr,
          signal,
        })
      : await capturePdf(bytes, stage, { signal });
    parserVersion = options.ocr ? "local-pdf-full-ocr-v1" : "local-native-pdf-window5-chunk800-v3";
    elements.push(...parsed.elements);
    images.push(...parsed.images);
  } else if ([".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
    const prepared = await stageImage(bytes, extension);
    elements.push({
      id: "element_0",
      text: basename(absolute),
      locator: { kind: "anchor", anchor: "filename" },
    });
    images.push({
      id: "image_0",
      blobHash: sourceHash,
      ...(prepared.rendition ? { rendition: prepared.rendition } : {}),
      locator: { kind: "anchor", anchor: "original" },
      originKind: "standalone_original",
      caption: basename(absolute),
      elementIds: ["element_0"],
    });
  } else {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.length > 1_000_000 || text.includes("\0"))
      throw new Error("Text exceeds budget or contains NUL");
    const lines = text.split("\n");
    let fence: string | undefined;
    for (let start = 0; start < lines.length; start += 20) {
      const chunk = lines.slice(start, start + 20).join("\n");
      if (chunk.length > 30_000)
        throw new Error(
          "Text element exceeds 30000-character indexing budget; split long lines or sections",
        );
      const element: CapturedElement = {
        id: `element_${elements.length}`,
        text: chunk,
        locator: {
          kind: "lines",
          start: start + 1,
          end: Math.min(start + 20, lines.length),
        },
      };
      elements.push(element);
      if (extension === ".txt") continue;
      for (
        let index = start;
        index < Math.min(start + 20, lines.length);
        index++
      ) {
        const line = lines[index]!;
        const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
        if (marker) {
          if (!fence) fence = marker[0];
          else if (fence === marker[0]) fence = undefined;
          continue;
        }
        if (fence) continue;
        const withoutCode = line.replace(/`[^`]*`/g, "");
        for (const match of withoutCode.matchAll(
          /!\[([^\]]*)\]\(([^\s()]+)\)/g,
        )) {
          const destination = decodeURIComponent(match[2]!);
          const imagePath = safeRelativeResource(
            dirname(absolute),
            destination,
          );
          if (
            !imagePath ||
            ![".png", ".jpg", ".jpeg", ".webp"].includes(
              extname(imagePath).toLowerCase(),
            )
          )
            throw new Error(
              "Only relative local PNG/JPEG/WebP images are supported",
            );
          await validatePath(imagePath);
          const imageBytes = await readRegularFileWithin(
            sourceRoot,
            imagePath,
            20 * 1024 * 1024,
          );
          const prepared = await stageImage(imageBytes, extname(imagePath));
          images.push({
            id: `image_${images.length}`,
            blobHash: sha256(imageBytes),
            ...(prepared.rendition ? { rendition: prepared.rendition } : {}),
            locator: { kind: "lines", start: index + 1, end: index + 1 },
            originKind: "embedded_original",
            caption: match[1]!,
            elementIds: [element.id],
          });
          if (images.length > 100)
            throw new Error("Image occurrence budget exceeded");
        }
        if (/!\[/.test(withoutCode.replace(/!\[([^\]]*)\]\(([^\s()]+)\)/g, "")))
          throw new Error(
            "Unsupported Markdown image syntax; use ![caption](relative.png)",
          );
        if (/<img\b/i.test(withoutCode))
          throw new Error("HTML images are unsupported in restricted Markdown");
      }
    }
  }
  if (elements.length > 5000 || images.length > 100)
    throw new Error("Document budget exceeded");
  if (images.some((image) => image.rendition)) parserVersion += "-rendition-v1";
  const revision = sha256(
    JSON.stringify([sourceHash, parserVersion, elements, images]),
  );
  const result: CapturedDocument = {
    id: `doc_${sha256(absolute)}`,
    revision,
    sourceHash,
    label: basename(absolute),
    parserVersion,
    elements,
    images,
  };
  validateCapture(result);
  for (const element of elements)
    if (element.provenance)
      await verifyOcrText(element.text, element.provenance, stage);
  for (const image of images)
    if (image.provenance) {
      await verifyOcrRender(image.provenance, stage);
      const transcript = new TextDecoder("utf-8", { fatal: true }).decode(
        await stage.get(image.provenance.transcriptHash),
      );
      const last = elements
        .filter((e) => image.elementIds.includes(e.id))
        .at(-1);
      if (last?.provenance?.transcriptEnd !== transcript.length)
        throw new Error("Incomplete OCR transcript coverage");
    }
  const checkPersistence = () => {
    signal?.throwIfAborted();
    if (Date.now() >= deadline)
      throw new Error("Document image deadline exceeded");
  };
  checkPersistence();
  for (const [hash, data] of pending) {
    checkPersistence();
    const storedHash = await blobs.put(data);
    // Cooperative deadline: an in-flight store operation cannot be interrupted.
    // Refuse late success and leave any unreferenced CAS blobs for explicit GC.
    checkPersistence();
    if (storedHash !== hash)
      throw new Error("Capture blob integrity mismatch");
  }
  checkPersistence();
  return result;
}

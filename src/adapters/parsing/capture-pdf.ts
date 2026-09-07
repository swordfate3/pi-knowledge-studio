import { chunkRetrievalText } from "../../core/retrieval-chunks.ts";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { CapturedElement, CapturedImage } from "../../domain/retrieval.ts";
import type { BlobStore } from "../../ports/blob-store.ts";
import { encodePng } from "../export/encode-png.ts";

export const PDF_CAPTURE_LIMITATIONS =
  "Default native text extraction without OCR or layout reconstruction. Mixed/scanned pages may have missing text, including scans with a native page-number overlay; this mode does not attest full-page coverage. Opt-in full-document OCR is separate. Images cover only supported decoded paintImageXObject bitmaps exposed by unpdf.extractImages; inline images, masks, vectors and other unsupported images may be omitted. PNGs are decoded_embedded derivatives, never original image bytes. Image/text links mean same page, not semantic association. The child is resource isolation, not a sandbox; heap/RSS limits are not a hard OS memory quota.";

const MAX_OUTPUT = 48 * 1024 * 1024;

export function runWorker(bytes: Uint8Array | { fd: number; maxBytes: number }, start: number, deadline: number, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  if (Date.now() >= deadline) return Promise.reject(new Error("PDF total deadline exceeded"));
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--max-old-space-size=192",
        fileURLToPath(new URL("./pdf-worker.mjs", import.meta.url)),
        String(start), String(start + 4),
        ...(bytes instanceof Uint8Array ? [] : ["fd", String(bytes.maxBytes)]),
      ],
      {
        env: {},
        stdio: ["pipe", "pipe", "pipe", ...(bytes instanceof Uint8Array ? [] : [bytes.fd])],
        cwd: fileURLToPath(new URL(".", import.meta.url)),
      },
    );
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let outputSize = 0;
    let errorSize = 0;
    let failure: Error | undefined;
    const stop = (message: string) => {
      failure ??= new Error(message);
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () => stop(Date.now() >= deadline ? "PDF total deadline exceeded" : "PDF parsing timeout (30 seconds)"),
      Math.min(30_000, Math.max(1, deadline - Date.now())),
    );
    // Parent sampling still runs while PDF.js blocks the child's event loop.
    // This is best-effort RSS observation, NOT a hard OS allocation limit.
    let closed = false, sampling = false;
    const rssTimer = process.platform === "linux" ? setInterval(() => {
      if (closed || sampling || !child.pid) return;
      sampling = true;
      void readFile(`/proc/${child.pid}/status`, "utf8").then(status => {
        const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
        if (!closed && rss && Number(rss[1]) * 1024 > 512 * 1024 * 1024) stop("PDF worker RSS budget exceeded (parent sample)");
      }).catch(() => { /* Exit races/proc availability: timeout and exit remain authoritative. */ })
        .finally(() => { sampling = false; });
    }, 50) : undefined;
    rssTimer?.unref();
    const abort = () => stop("PDF parsing aborted");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout!.on("data", (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > MAX_OUTPUT) stop("PDF worker output budget exceeded");
      else output.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      errorSize += chunk.length;
      if (errorSize > 16 * 1024) stop("PDF worker stderr budget exceeded");
      else errors.push(chunk);
    });
    child.on("error", () => stop("Unable to start PDF worker"));
    child.stdin!.on("error", () => {
      /* Exit status/timeout is authoritative (including early EPIPE). */
    });
    child.on("close", (code) => {
      closed = true;
      clearInterval(rssTimer);
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code === 0) resolve(Buffer.concat(output));
      else
        reject(
          new Error(
            `PDF parsing failed: ${
              Buffer.concat(errors)
                .toString("utf8")
                .replace(/[\x00-\x1f\x7f]/g, " ")
                .slice(0, 2048) || "worker exited or exceeded memory budget"
            }`,
          ),
        );
    });
    child.stdin!.end(bytes instanceof Uint8Array ? bytes : undefined);
  });
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error("Invalid PDF worker object");
  return value as Record<string, unknown>;
}
function integer(value: unknown, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > max
  )
    throw new Error("Invalid PDF worker integer");
  return value;
}

export interface PdfBudgets { text: number; pixels: number; images: number }
/** Strict window protocol; caller owns document-wide cumulative budgets. */
export function validatePdfWindow(output: Buffer, start: number, expectedTotal: number | undefined, budgets: PdfBudgets, maxPages = 200) {
  if (output.length > MAX_OUTPUT) throw new Error("PDF worker output budget exceeded");
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(output),
    ) as unknown;
  } catch {
    throw new Error("Invalid PDF worker JSON or UTF-8");
  }
  const root = record(parsed, ["totalPages", "start", "end", "pages"]);
  const totalPages = integer(root.totalPages, maxPages);
  const end = Math.min(start + 4, totalPages);
  if (root.start !== start || root.end !== end || (expectedTotal !== undefined && totalPages !== expectedTotal))
    throw new Error("Invalid PDF worker window metadata");
  if (
    !Array.isArray(root.pages) ||
    !root.pages.length ||
    root.pages.length !== end - start + 1
  )
    throw new Error("Invalid PDF worker pages");
  const pages = root.pages.map((value: unknown, index: number) => {
    const page = record(value, ["page", "text", "images"]);
    if (
      integer(page.page, maxPages) !== start + index ||
      typeof page.text !== "string" ||
      page.text.length > 100_000 ||
      page.text.includes("\0") ||
      !Array.isArray(page.images)
    )
      throw new Error("Invalid PDF worker page");
    budgets.text += page.text.length;
    if (budgets.text > 1_000_000) throw new Error("PDF text budget exceeded");
    const images = page.images.map((value: unknown) => {
      const image = record(value, ["width", "height", "channels", "data"]);
      const width = integer(image.width, 4_000_000);
      const height = integer(image.height, 4_000_000);
      const channels = integer(image.channels, 4);
      budgets.pixels += width * height;
      if (
        ![1, 3, 4].includes(channels) ||
        width * height > 4_000_000 ||
        budgets.pixels > 8_000_000 ||
        ++budgets.images > 100
      )
        throw new Error("PDF image budget exceeded");
      const length = width * height * channels;
      if (
        typeof image.data !== "string" ||
        image.data.length !== 4 * Math.ceil(length / 3)
      )
        throw new Error("Invalid PDF worker bitmap encoding");
      const data = Buffer.from(image.data, "base64");
      if (data.length !== length || data.toString("base64") !== image.data)
        throw new Error("Invalid PDF worker bitmap bytes");
      return { width, height, channels, data };
    });
    return { page: start + index, text: page.text, images };
  });
  return { totalPages, pages };
}

/** Capture sequential page text and supported decoded bitmaps; all worker data is validated before blob writes. */
export async function capturePdf(
  bytes: Uint8Array,
  blobs: BlobStore,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<{ elements: CapturedElement[]; images: CapturedImage[] }> {
  if (
    !(bytes instanceof Uint8Array) ||
    !bytes.length ||
    bytes.length > 20 * 1024 * 1024
  )
    throw new Error("PDF input must contain 1 byte to 20 MiB");
  const deadline = Date.now() + 120_000;
  const check = () => {
    options.signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new Error("PDF total deadline exceeded");
  };
  const budgets: PdfBudgets = { text: 0, pixels: 0, images: 0 };
  const pages: ReturnType<typeof validatePdfWindow>["pages"] = [];
  let totalPages: number | undefined;
  for (let start = 1; totalPages === undefined || start <= totalPages; start += 5) {
    check();
    const window = validatePdfWindow(await runWorker(bytes, start, deadline, options.signal), start, totalPages, budgets);
    totalPages = window.totalPages;
    pages.push(...window.pages);
  }
  check();
  if (pages.length !== totalPages) throw new Error("Incomplete PDF pages");
  if (!pages.some((page) => page.text.trim()))
    throw new Error("PDF has no extractable text (empty or scanned document); OCR is not supported");
  // Complete chunk construction and validation before any image blob writes.
  const pageChunks = pages.map((page) => chunkRetrievalText(page.text));
  if (pageChunks.reduce((sum, chunks) => sum + chunks.length, 0) > 5000)
    throw new Error("PDF element budget exceeded");
  const elements: CapturedElement[] = [];
  const images: CapturedImage[] = [];
  for (const page of pages) {
    const locator = { kind: "page" as const, page: page.page };
    const elementIds: string[] = [];
    for (const chunk of pageChunks[page.page - 1]!) {
      const id = `element_${elements.length}`;
      elements.push({
        id,
        text: chunk.text,
        locator,
      });
      elementIds.push(id);
    }
    for (const image of page.images) {
      check();
      const blobHash = await blobs.put(
        encodePng(image.width, image.height, image.channels, image.data),
      );
      if (!/^[a-f0-9]{64}$/.test(blobHash))
        throw new Error("Invalid PDF image blob hash");
      images.push({
        id: `image_${images.length}`,
        blobHash,
        locator,
        originKind: "decoded_embedded",
        caption: `Decoded embedded bitmap on PDF page ${page.page}`,
        elementIds: [...elementIds],
      });
    }
  }
  check();
  return { elements, images };
}

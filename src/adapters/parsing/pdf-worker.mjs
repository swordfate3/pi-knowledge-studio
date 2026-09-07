// Resource-isolated parser, NOT a security sandbox. No caller environment or URLs.
import { getDocumentProxy, extractImages, getResolvedPDFJS } from "unpdf";

import { fstatSync, readSync } from "node:fs";
const fileMode = process.argv[4] === "fd";
const INPUT = 20 * 1024 * 1024;
const OUTPUT = 48 * 1024 * 1024;
// Keep PDF.js diagnostics off the JSON channel; parent bounds stderr separately.
console.log = console.info = console.warn = console.error;
globalThis.fetch = async () => {
  throw new Error("External PDF resources are disabled");
};
class NoResources {
  async fetch() {
    throw new Error("External PDF resources are disabled");
  }
}
const memoryTimer = setInterval(() => {
  if (process.memoryUsage().rss > 512 * 1024 * 1024) process.exit(2);
}, 50);
memoryTimer.unref();

try {
  const start = Number(process.argv[2]), requestedEnd = Number(process.argv[3]);
  if (!Number.isInteger(start) || start < 1 || !Number.isInteger(requestedEnd) || requestedEnd < start || requestedEnd - start >= 5)
    throw new Error("Invalid PDF window request");
  let data;
  let range;
  if (fileMode) {
    // fd 3 is an already-open, verified private spool, not an arbitrary worker path.
    const size = fstatSync(3).size;
    const max = Number(process.argv[5]);
    if (!Number.isSafeInteger(max) || size < 1 || size > max || !fstatSync(3).isFile())
      throw new Error("PDF input budget exceeded");
    const { PDFDataRangeTransport } = await getResolvedPDFJS();
    // Range I/O avoids a parent-side whole-source copy, but PDF.js still allocates
    // a source-length ChunkedStream backing buffer. Neither this transport nor
    // sampled RSS establishes a hard memory bound independent of source size.
    range = new (class extends PDFDataRangeTransport {
      requestDataRange(begin, end) {
        if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end > size || end <= begin || end - begin > 8 * 1024 * 1024)
          throw new Error("PDF range budget exceeded");
        const bytes = new Uint8Array(end - begin);
        let offset = 0;
        while (offset < bytes.length) {
          const n = readSync(3, bytes, offset, bytes.length - offset, begin + offset);
          if (!n) throw new Error("Truncated PDF spool");
          offset += n;
        }
        queueMicrotask(() => this.onDataRange(begin, bytes));
      }
    })(size, new Uint8Array(0));
    range.transportReady();
  } else {
    const chunks = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > INPUT) throw new Error("PDF input budget exceeded");
      chunks.push(chunk);
    }
    if (!length) throw new Error("Empty PDF input");
    data = new Uint8Array(Buffer.concat(chunks));
  }
  const pdf = await getDocumentProxy(data, {
    ...(fileMode ? { data: undefined, range, rangeChunkSize: 65536 } : {}),
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: false,
    disableAutoFetch: true,
    disableStream: true,
    cMapUrl: undefined,
    standardFontDataUrl: undefined,
    wasmUrl: undefined,
    CMapReaderFactory: NoResources,
    StandardFontDataFactory: NoResources,
    WasmFactory: NoResources,
    useWasm: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    maxImageSize: 4_000_000,
    verbosity: 0,
  });
  try {
    if (
      !Number.isInteger(pdf.numPages) ||
      pdf.numPages < 1 ||
      (!fileMode && pdf.numPages > 200)
    )
      throw new Error("PDF page budget exceeded");
    const end = Math.min(requestedEnd, pdf.numPages);
    if (start > end) throw new Error("Invalid PDF window range");
    const pages = [];
    let textLength = 0;
    let pixels = 0;
    let imageCount = 0;
    for (let pageNumber = start; pageNumber <= end; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (typeof item.str !== "string") continue;
        text += item.str + (item.hasEOL ? "\n" : " ");
        if (text.length > 100_000)
          throw new Error("PDF page text budget exceeded");
      }
      // Preserve extracted text verbatim (including separators) for lossless chunk spans.
      textLength += text.length;
      if (text.includes("\0") || textLength > 1_000_000)
        throw new Error("Invalid PDF text or text budget exceeded");
      const images = [];
      // unpdf 1.8: withDocument recognizes this proxy; extractImages calls only
      // getPage(pageNumber).getOperatorList(), never extractText/all pages.
      for (const image of await extractImages(pdf, pageNumber)) {
        const { width, height, channels, data } = image;
        if (
          !Number.isInteger(width) ||
          !Number.isInteger(height) ||
          width < 1 ||
          height < 1 ||
          ![1, 3, 4].includes(channels) ||
          !(data instanceof Uint8Array || data instanceof Uint8ClampedArray) ||
          data.length !== width * height * channels
        )
          throw new Error("Invalid decoded PDF bitmap");
        pixels += width * height;
        if (
          width * height > 4_000_000 ||
          pixels > 8_000_000 ||
          ++imageCount > 100
        )
          throw new Error("PDF image budget exceeded");
        images.push({
          width,
          height,
          channels,
          data: Buffer.from(data).toString("base64"),
        });
      }
      pages.push({ page: pageNumber, text, images });
      page.cleanup();
    }
    const output = JSON.stringify({ totalPages: pdf.numPages, start, end, pages });
    if (Buffer.byteLength(output) > OUTPUT)
      throw new Error("PDF output budget exceeded");
    process.stdout.write(output);
  } finally {
    await pdf.loadingTask.destroy();
  }
} catch (error) {
  process.stderr.write(
    (error instanceof Error ? error.message : "PDF parsing failed").slice(
      0,
      2048,
    ),
  );
  process.exitCode = 1;
} finally {
  clearInterval(memoryTimer);
}

import { OCR_PARSER, validateOcr } from "../domain/ocr.ts";
import { validateRendition } from "../domain/rendition.ts";
import { sha256 } from "../adapters/blob/file-blob-store.ts";
import type { CapturedDocument } from "../domain/retrieval.ts";

export function captureRevision(
  document: Omit<CapturedDocument, "revision">,
): string {
  return sha256(
    JSON.stringify([
      document.sourceHash,
      document.parserVersion,
      document.elements,
      document.images,
    ]),
  );
}

/** Database/parser records are data, not authority to invent export references or paths. */
export function validateCapture(document: CapturedDocument): void {
  if (
    !document ||
    !/^doc_[a-f0-9]{64}$/.test(document.id) ||
    !/^[a-f0-9]{64}$/.test(document.sourceHash) ||
    typeof document.label !== "string" ||
    document.label.length > 1000 ||
    typeof document.parserVersion !== "string" ||
    document.parserVersion.length > 200 ||
    !Array.isArray(document.elements) ||
    !Array.isArray(document.images) ||
    document.elements.length > 5000 ||
    document.images.length > 100
  )
    throw new Error("Invalid captured document");
  const ids = new Set<string>();
  for (const item of [...document.elements, ...document.images]) {
    if (
      !item ||
      typeof item.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(item.id) ||
      ids.has(item.id)
    )
      throw new Error("Invalid or duplicate capture identifier");
    ids.add(item.id);
    const loc = item.locator;
    if (
      !loc ||
      !(
        (loc.kind === "page" &&
          Number.isSafeInteger(loc.page) &&
          loc.page > 0) ||
        (loc.kind === "lines" &&
          Number.isSafeInteger(loc.start) &&
          Number.isSafeInteger(loc.end) &&
          loc.start > 0 &&
          loc.end >= loc.start) ||
        (loc.kind === "anchor" &&
          typeof loc.anchor === "string" &&
          loc.anchor.length <= 1000)
      )
    )
      throw new Error("Invalid capture locator");
  }
  let total = 0;
  for (const element of document.elements) {
    if (typeof element.text !== "string" || element.text.length > 100_000)
      throw new Error("Invalid capture text");
    total += element.text.length;
  }
  if (total > 2_000_000) throw new Error("Capture text budget exceeded");
  const elementIds = new Set(document.elements.map((element) => element.id));
  for (const image of document.images) {
    if (image.rendition !== undefined) validateRendition(image.rendition);
    if (
      !/^[a-f0-9]{64}$/.test(image.blobHash) ||
      typeof image.caption !== "string" ||
      image.caption.length > 100_000 ||
      ![
        "standalone_original",
        "embedded_original",
        "decoded_embedded",
        "page_render",
        "page_crop",
      ].includes(image.originKind) ||
      !Array.isArray(image.elementIds) ||
      image.elementIds.length > 5000 ||
      image.elementIds.some((id) => !elementIds.has(id))
    )
      throw new Error("Invalid captured image");
  }
  if (
    document.parserVersion === OCR_PARSER ||
    document.elements.some((e) => e.provenance) ||
    document.images.some((i) => i.provenance)
  ) {
    if (document.parserVersion !== OCR_PARSER || !document.images.length)
      throw new Error("Invalid OCR capture variant");
    const first = document.images[0]!.provenance;
    if (!first || first.pageCount !== document.images.length)
      throw new Error("Incomplete OCR page coverage");
    for (const [index, image] of document.images.entries()) {
      const p = image.provenance;
      if (!p) throw new Error("Missing OCR render provenance");
      validateOcr(p, false);
      if (
        p.sourceHash !== document.sourceHash ||
        p.page !== index + 1 ||
        p.pageCount !== first.pageCount ||
        p.stackFingerprint !== first.stackFingerprint ||
        image.originKind !== "page_render" ||
        image.rendition ||
        image.blobHash !== p.pageRenderHash ||
        image.locator.kind !== "page" ||
        image.locator.page !== p.page
      )
        throw new Error("OCR render binding mismatch");
      const chunks = document.elements.filter((e) =>
        image.elementIds.includes(e.id),
      );
      if (!chunks.length) throw new Error("Missing OCR transcript elements");
      let offset = 0;
      for (const e of chunks) {
        if (!e.provenance) throw new Error("Missing OCR transcript provenance");
        validateOcr(e.provenance, true);
        const { transcriptStart, transcriptEnd, ...page } = e.provenance;
        if (
          JSON.stringify(page) !== JSON.stringify(p) ||
          transcriptStart !== offset ||
          transcriptEnd - transcriptStart !== e.text.length ||
          e.locator.kind !== "page" ||
          e.locator.page !== p.page
        )
          throw new Error("OCR transcript binding mismatch");
        offset = transcriptEnd;
      }
    }
    for (const element of document.elements)
      if (
        document.images.filter((i) => i.elementIds.includes(element.id))
          .length !== 1
      )
        throw new Error("OCR element must bind exactly one page");
  }
  if (captureRevision(document) !== document.revision)
    throw new Error("Captured revision integrity mismatch");
}

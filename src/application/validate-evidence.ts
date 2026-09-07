import { validateOcr } from "../domain/ocr.ts";
import { validateRendition } from "../domain/rendition.ts";
import type {
  EvidenceBundle,
  IllustratedDocument,
  Locator,
} from "../domain/evidence.ts";
import { createHash } from "node:crypto";

function requireValue(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function identifier(id: string): void {
  requireValue(
    typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id),
    "Invalid evidence identifier",
  );
}

function text(value: string): void {
  requireValue(
    typeof value === "string" && value.length <= 100_000,
    "Invalid or oversized text",
  );
}

function locator(value: Locator): void {
  if (value.kind === "page") {
    requireValue(
      Number.isSafeInteger(value.page) && value.page > 0,
      "Invalid page locator",
    );
  } else if (value.kind === "lines") {
    requireValue(
      Number.isSafeInteger(value.start) &&
        Number.isSafeInteger(value.end) &&
        value.start > 0 &&
        value.end >= value.start,
      "Invalid line locator",
    );
  } else {
    requireValue(value.kind === "anchor", "Invalid locator kind");
    text(value.anchor);
  }
}

/** Validates references, not the semantic truth of generated claims. */
export function validateEvidence(
  bundle: EvidenceBundle,
  document: IllustratedDocument,
): void {
  requireValue(bundle.schemaVersion === 1, "Unsupported evidence schema");
  identifier(bundle.id);
  identifier(bundle.snapshotId);
  requireValue(
    document.bundleId === bundle.id,
    "Document belongs to another bundle",
  );
  requireValue(
    document.mode === "evidence-compilation" ||
      document.mode === "model-generated",
    "Invalid document mode",
  );
  text(document.title);
  requireValue(
    bundle.sources.length <= 100 &&
      bundle.texts.length <= 100 &&
      bundle.images.length <= 100 &&
      document.blocks.length <= 200,
    "Evidence budget exceeded",
  );
  const allIds = new Set<string>();
  const addId = (id: string) => {
    identifier(id);
    requireValue(!allIds.has(id), "Duplicate evidence identifier");
    allIds.add(id);
  };
  const sourceIds = new Set(bundle.sources.map((source) => source.id));
  for (const source of bundle.sources) {
    addId(source.id);
    text(source.label);
    requireValue(
      /^[a-f0-9]{64}$/.test(source.revisionHash),
      "Invalid revision hash",
    );
  }
  for (const item of [...bundle.texts, ...bundle.images]) {
    addId(item.id);
    requireValue(sourceIds.has(item.sourceId), "Unknown source reference");
    locator(item.locator);
  }
  for (const item of bundle.texts) {
    if (item.provenance) {
      validateOcr(item.provenance, true);
      const p = item.provenance;
      if (
        item.locator.kind !== "page" ||
        item.locator.page !== p.page ||
        item.end > p.transcriptEnd - p.transcriptStart ||
        !bundle.images.some(
          (i) =>
            i.sourceId === item.sourceId &&
            i.blobHash === p.pageRenderHash &&
            i.provenance &&
            i.provenance.transcriptHash === p.transcriptHash &&
            i.provenance.sourceHash === p.sourceHash &&
            i.provenance.page === p.page &&
            i.provenance.stackFingerprint === p.stackFingerprint &&
            i.provenance.pageCount === p.pageCount &&
            i.provenance.width === p.width &&
            i.provenance.height === p.height &&
            i.provenance.recipeFingerprint === p.recipeFingerprint,
        )
      )
        throw new Error("OCR evidence missing bound page render");
    }
    identifier(item.elementId);
    text(item.text);
    requireValue(
      Number.isSafeInteger(item.start) &&
        Number.isSafeInteger(item.end) &&
        item.start >= 0 &&
        item.end - item.start === item.text.length,
      "Invalid excerpt offsets",
    );
    requireValue(
      createHash("sha256").update(item.text).digest("hex") === item.textHash,
      "Excerpt integrity mismatch",
    );
  }
  const origins = new Set([
    "standalone_original",
    "embedded_original",
    "decoded_embedded",
    "page_render",
    "page_crop",
  ]);
  for (const image of bundle.images) {
    if (image.provenance) {
      validateOcr(image.provenance, false);
      if (
        image.originKind !== "page_render" ||
        image.rendition ||
        image.blobHash !== image.provenance.pageRenderHash ||
        image.locator.kind !== "page" ||
        image.locator.page !== image.provenance.page
      )
        throw new Error("OCR image binding mismatch");
    }
    if (image.rendition !== undefined) validateRendition(image.rendition);
    requireValue(origins.has(image.originKind), "Unknown image origin");
    requireValue(/^[a-f0-9]{64}$/.test(image.blobHash), "Invalid image hash");
  }
  const texts = new Set(bundle.texts.map((item) => item.id));
  const images = new Set(bundle.images.map((item) => item.id));
  for (const block of document.blocks) {
    requireValue(
      block.kind === "paragraph" || block.kind === "figure",
      "Unsupported document block",
    );
    requireValue(
      Array.isArray(block.evidenceIds) &&
        (block.kind === "figure" || block.evidenceIds.length > 0) &&
        block.evidenceIds.length <= 100,
      "Missing or excessive evidence references",
    );
    for (const id of block.evidenceIds)
      requireValue(texts.has(id), "Unknown text evidence reference");
    if (block.kind === "paragraph") text(block.text);
    else {
      text(block.caption);
      requireValue(images.has(block.occurrenceId), "Unknown image occurrence");
    }
  }
}

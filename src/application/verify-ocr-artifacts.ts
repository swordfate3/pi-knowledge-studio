import type { OcrPage } from "../domain/ocr.ts";
import { validateOcr } from "../domain/ocr.ts";
import type { BlobStore } from "../ports/blob-store.ts";
import { sha256 } from "../adapters/blob/file-blob-store.ts";
import { validatePng } from "../adapters/export/png.ts";
/** Recheck retained render bytes; recognition correctness is never inferred. */
export async function verifyOcrRender(
  provenance: OcrPage,
  blobs: BlobStore,
): Promise<void> {
  validateOcr(provenance, false);
  const bytes = Buffer.from(await blobs.get(provenance.pageRenderHash));
  if (
    bytes.length > 8 * 1024 * 1024 ||
    sha256(bytes) !== provenance.pageRenderHash
  )
    throw new Error("OCR render integrity mismatch");
  validatePng(bytes);
  if (
    bytes.readUInt32BE(16) !== provenance.width ||
    bytes.readUInt32BE(20) !== provenance.height
  )
    throw new Error("OCR render geometry mismatch");
}

import type { BlobStore } from "../ports/blob-store.ts";
import { createHash } from "node:crypto";
const sha256 = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export const OCR_WARNING =
  "Unverified OCR transcript—not an exact original quotation. Page images are derived renders, not embedded originals.";
export const OCR_PARSER = "local-pdf-full-ocr-v1";
export const OCR_RECIPE =
  "poppler:png,r200,scale-to-min2000-floor-longestpts200over72;tesseract:eng+chi_sim,oem1,psm6;full-document-v1";
/** No executable paths or private configuration values belong in public provenance. */
export interface OcrPage {
  kind: "ocr";
  verification: "unverified";
  sourceHash: string;
  page: number;
  pageCount: number;
  pageRenderHash: string;
  transcriptHash: string;
  stackFingerprint: string;
  recipeFingerprint: string;
  width: number;
  height: number;
}
export interface OcrText extends OcrPage {
  transcriptStart: number;
  transcriptEnd: number;
}
const pageKeys = [
  "kind",
  "verification",
  "sourceHash",
  "page",
  "pageCount",
  "pageRenderHash",
  "transcriptHash",
  "stackFingerprint",
  "recipeFingerprint",
  "width",
  "height",
];
export function validateOcr(value: OcrPage | OcrText, isText: boolean): void {
  const keys = [
    ...pageKeys,
    ...(isText ? ["transcriptStart", "transcriptEnd"] : []),
  ];
  if (
    !value ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    value.kind !== "ocr" ||
    value.verification !== "unverified"
  )
    throw new Error("Invalid OCR provenance");
  for (const key of [
    "sourceHash",
    "pageRenderHash",
    "transcriptHash",
    "stackFingerprint",
    "recipeFingerprint",
  ] as const)
    if (typeof value[key] !== "string" || !/^[a-f0-9]{64}$/.test(value[key]))
      throw new Error("Invalid OCR hash");
  if (
    value.recipeFingerprint !== sha256(OCR_RECIPE) ||
    !Number.isSafeInteger(value.page) ||
    !Number.isSafeInteger(value.pageCount) ||
    value.page < 1 ||
    value.page > value.pageCount ||
    value.pageCount > 20 ||
    !Number.isSafeInteger(value.width) ||
    !Number.isSafeInteger(value.height) ||
    value.width < 1 ||
    value.height < 1 ||
    value.width > 2000 ||
    value.height > 2000 ||
    value.width * value.height > 4_000_000
  )
    throw new Error("Invalid OCR page/recipe");
  if (isText) {
    const text = value as OcrText;
    if (
      !Number.isSafeInteger(text.transcriptStart) ||
      !Number.isSafeInteger(text.transcriptEnd) ||
      text.transcriptStart < 0 ||
      text.transcriptEnd <= text.transcriptStart ||
      text.transcriptEnd > 100_000 ||
      text.transcriptEnd - text.transcriptStart > 30_000
    )
      throw new Error("Invalid OCR transcript offsets");
  }
}
export async function verifyOcrText(
  text: string,
  provenance: OcrText,
  blobs: BlobStore,
  start = 0,
): Promise<void> {
  validateOcr(provenance, true);
  const bytes = await blobs.get(provenance.transcriptHash);
  if (bytes.length > 400_000 || sha256(bytes) !== provenance.transcriptHash)
    throw new Error("OCR transcript integrity mismatch");
  const transcript = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (
    transcript.length > 100_000 ||
    !transcript.trim() ||
    provenance.transcriptEnd > transcript.length ||
    start < 0 ||
    provenance.transcriptStart + start + text.length >
      provenance.transcriptEnd ||
    transcript.slice(
      provenance.transcriptStart + start,
      provenance.transcriptStart + start + text.length,
    ) !== text
  )
    throw new Error("OCR transcript slice mismatch");
}

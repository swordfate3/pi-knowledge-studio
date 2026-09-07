import type { OcrPage, OcrText } from "./ocr.ts";
import type { ImageRendition } from "./rendition.ts";
import type { Locator, OriginKind } from "./evidence.ts";

export interface CapturedElement {
  provenance?: OcrText;
  id: string;
  text: string;
  locator: Locator;
}
export interface CapturedImage {
  provenance?: OcrPage;
  id: string;
  blobHash: string;
  rendition?: ImageRendition;
  locator: Locator;
  originKind: OriginKind;
  caption: string;
  elementIds: string[];
}
/** Immutable, local parser output; all referenced blobs must exist before publication. */
export interface CapturedDocument {
  id: string;
  revision: string;
  label: string;
  sourceHash: string;
  parserVersion: string;
  elements: CapturedElement[];
  images: CapturedImage[];
}
export interface EmbeddingSpace {
  provider: string;
  model: string;
  revision: string;
  dimension: number;
  queryInstruction: string;
  documentInstruction: string;
}
export interface EmbeddingProvider {
  space: EmbeddingSpace;
  embed(texts: string[], purpose: "query" | "document"): Promise<number[][]>;
}
export interface SearchHit {
  document: CapturedDocument;
  element: CapturedElement;
  score: number;
  lexicalRank?: number;
  denseRank?: number;
}

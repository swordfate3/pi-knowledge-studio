import type { OcrPage, OcrText } from "./ocr.ts";
import type { ImageRendition } from "./rendition.ts";
/** V2 export contracts. Retrieval and publication snapshots are implemented separately. */
export type OriginKind =
    | "standalone_original"
    | "embedded_original"
    | "decoded_embedded"
    | "page_render"
    | "page_crop";

export interface SourceReference {
    id: string;
    /** Shareable label, never a private filesystem path. */
    label: string;
    revisionHash: string;
}

export type Locator =
    | { kind: "page"; page: number }
    | { kind: "lines"; start: number; end: number }
    | { kind: "anchor"; anchor: string };

export interface TextEvidence {
    provenance?: OcrText;
    id: string;
    sourceId: string;
    elementId: string;
    locator: Locator;
    /** Exact excerpt supplied by the capture/parser layer, not an LLM summary. */
    text: string;
    textHash: string;
    /** Offsets into the source element, measured in JS UTF-16 code units. */
    start: number;
    end: number;
}

export interface ImageOccurrence {
    provenance?: OcrPage;
    id: string;
    sourceId: string;
    locator: Locator;
    blobHash: string;
    rendition?: ImageRendition;
    originKind: OriginKind;
}

export interface EvidenceBundle {
    schemaVersion: 1;
    id: string;
    snapshotId: string;
    sources: SourceReference[];
    texts: TextEvidence[];
    images: ImageOccurrence[];
}

export type DocumentBlock =
    | { kind: "paragraph"; text: string; evidenceIds: string[] }
    | {
          kind: "figure";
          occurrenceId: string;
          caption: string;
          evidenceIds: string[];
      };

export interface IllustratedDocument {
    title: string;
    bundleId: string;
    /** Deterministic evidence compilations must not masquerade as model generation. */
    mode: "evidence-compilation" | "model-generated";
    blocks: DocumentBlock[];
}

export interface ExportPermission {
    /** Approves the complete title/body/captions, which may themselves quote source text. */
    documentContent: boolean;
    /** Caller must approve sharing all selected images (including embedded metadata). */
    images: boolean;
    /** Controls supplementary evidence excerpts only; this is not a content redactor. */
    excerpts: boolean;
}

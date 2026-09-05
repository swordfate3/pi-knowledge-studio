export type AssetKind =
  | "image"
  | "page"
  | "table"
  | "audio"
  | "video"
  | "other";

export interface Locator {
  sourceUri: string;
  page?: number;
  lineStart?: number;
  lineEnd?: number;
  sectionPath?: string[];
  fragment?: string;
}

export interface DocumentRecord {
  id: string;
  collection: string;
  sourceUri: string;
  title: string;
  mimeType: string;
  sha256: string;
  importedAt: string;
  profile: string;
  metadata: Record<string, unknown>;
}

export interface ChunkRecord {
  id: string;
  documentId: string;
  collection: string;
  ordinal: number;
  text: string;
  locator: Locator;
  metadata: Record<string, unknown>;
}

export interface AssetRecord {
  id: string;
  documentId: string;
  collection: string;
  kind: AssetKind;
  sourceUri: string;
  storedPath: string;
  mimeType: string;
  sha256: string;
  locator: Locator;
  title?: string;
  caption?: string;
  ocrText?: string;
  metadata: Record<string, unknown>;
}

export interface AnnotationRecord {
  id: string;
  assetId: string;
  collection: string;
  type: "ocr" | "caption" | "vision" | "manual";
  text: string;
  model?: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface CollectionManifest {
  schemaVersion: 1;
  name: string;
  profile: string;
  createdAt: string;
  updatedAt: string;
  documentCount: number;
  chunkCount: number;
  assetCount: number;
  annotationCount: number;
}

export interface CollectionData {
  manifest: CollectionManifest;
  documents: DocumentRecord[];
  chunks: ChunkRecord[];
  assets: AssetRecord[];
  annotations: AnnotationRecord[];
}

export interface IngestResult {
  collection: string;
  document: DocumentRecord;
  chunks: ChunkRecord[];
  assets: AssetRecord[];
  warnings: string[];
}

export interface SearchHit {
  kind: "chunk" | "asset";
  score: number;
  text: string;
  locator: Locator;
  documentId: string;
  assetId?: string;
  storedPath?: string;
  title?: string;
  caption?: string;
}

export interface SearchOptions {
  collection: string;
  query: string;
  limit?: number;
  includeAssets?: boolean;
}

export interface Profile {
  id: string;
  name: string;
  description: string;
  terminology: string[];
  explanationGuidance: string;
  documentTemplate: string;
}

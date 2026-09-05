import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface StudioConfig {
  dataRoot: string;
  defaultProfile: string;
  maxChunkChars: number;
  chunkOverlapChars: number;
  maxAssetBytes: number;
  maxSourceBytes: number;
  maxPdfPages: number;
  maxPdfImagePixels: number;
  maxPdfExtractionMs: number;
  maxExtractedTextChars: number;
  maxVisionImagePixels: number;
  maxVisionRequestBytes: number;
  visionBaseUrl?: string;
  visionModel?: string;
  visionApiKey?: string;
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveDataRoot(
  cwd: string,
  scope: "project" | "global" = "project",
): string {
  const configured = process.env.PI_KNOWLEDGE_STUDIO_HOME?.trim();
  if (configured) return resolve(configured);
  return scope === "global"
    ? join(homedir(), ".pi", "knowledge-studio")
    : join(cwd, ".pi", "knowledge-studio");
}

export function loadConfig(cwd: string): StudioConfig {
  const visionBaseUrl =
    process.env.PI_KNOWLEDGE_STUDIO_VISION_BASE_URL?.trim() || undefined;
  const visionModel =
    process.env.PI_KNOWLEDGE_STUDIO_VISION_MODEL?.trim() || undefined;
  const visionApiKey =
    process.env.PI_KNOWLEDGE_STUDIO_VISION_API_KEY ||
    process.env.OPENAI_API_KEY ||
    undefined;
  return {
    dataRoot: resolveDataRoot(cwd),
    defaultProfile:
      process.env.PI_KNOWLEDGE_STUDIO_PROFILE?.trim() || "general",
    maxChunkChars: positiveInt(
      process.env.PI_KNOWLEDGE_STUDIO_MAX_CHUNK_CHARS,
      1800,
    ),
    chunkOverlapChars: positiveInt(
      process.env.PI_KNOWLEDGE_STUDIO_CHUNK_OVERLAP_CHARS,
      200,
    ),
    maxAssetBytes: positiveInt(
      process.env.PI_KNOWLEDGE_STUDIO_MAX_ASSET_BYTES,
      20 * 1024 * 1024,
    ),
    maxSourceBytes: positiveInt(
      process.env.PI_KNOWLEDGE_STUDIO_MAX_SOURCE_BYTES,
      100 * 1024 * 1024,
    ),
    maxPdfPages: positiveInt(
      process.env.PI_KNOWLEDGE_STUDIO_MAX_PDF_PAGES,
      2000,
    ),
    maxPdfImagePixels: positiveInt(
      process.env.PI_KNOWLEDGE_STUDIO_MAX_PDF_IMAGE_PIXELS,
      16_777_216,
    ),
    maxPdfExtractionMs: positiveInt(
      process.env.PI_KNOWLEDGE_STUDIO_MAX_PDF_EXTRACTION_MS,
      120_000,
    ),
    maxExtractedTextChars: positiveInt(
      process.env.PI_KNOWLEDGE_STUDIO_MAX_EXTRACTED_TEXT_CHARS,
      10 * 1024 * 1024,
    ),
    maxVisionImagePixels: positiveInt(
      process.env.PI_KNOWLEDGE_STUDIO_MAX_VISION_IMAGE_PIXELS,
      40_000_000,
    ),
    maxVisionRequestBytes: positiveInt(
      process.env.PI_KNOWLEDGE_STUDIO_MAX_VISION_REQUEST_BYTES,
      12 * 1024 * 1024,
    ),
    ...(visionBaseUrl ? { visionBaseUrl } : {}),
    ...(visionModel ? { visionModel } : {}),
    ...(visionApiKey ? { visionApiKey } : {}),
  };
}

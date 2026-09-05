// @ts-ignore TS2691: Pi loads the TypeScript extension source through its Jiti loader.
import { lexicalScore } from "../core/chunking.ts";
// @ts-ignore TS2691: Pi loads the TypeScript extension source through its Jiti loader.
import type {
  AssetRecord,
  ChunkRecord,
  CollectionData,
  SearchHit,
  SearchOptions,
} from "../core/types.ts";

export function searchCollection(
  data: CollectionData,
  options: SearchOptions,
): SearchHit[] {
  const limit = Math.min(Math.max(options.limit ?? 8, 1), 50);
  const hits: SearchHit[] = data.chunks.map((chunk: ChunkRecord) => ({
    kind: "chunk" as const,
    score: lexicalScore(options.query, chunk.text),
    text: chunk.text,
    locator: chunk.locator,
    documentId: chunk.documentId,
  }));
  if (options.includeAssets) {
    hits.push(
      ...data.assets.map((asset: AssetRecord) => {
        const text = [
          asset.title,
          asset.caption,
          asset.ocrText,
          asset.sourceUri,
        ]
          .filter(Boolean)
          .join(" ");
        return {
          kind: "asset" as const,
          score: lexicalScore(options.query, text),
          text:
            asset.caption ?? asset.ocrText ?? asset.title ?? asset.sourceUri,
          locator: asset.locator,
          documentId: asset.documentId,
          assetId: asset.id,
          storedPath: asset.storedPath,
          ...(asset.title ? { title: asset.title } : {}),
          ...(asset.caption ? { caption: asset.caption } : {}),
        };
      }),
    );
  }
  return hits
    .filter((hit) => hit.score > 0)
    .sort(
      (a, b) => b.score - a.score || a.documentId.localeCompare(b.documentId),
    )
    .slice(0, limit);
}

export function searchAssets(
  data: CollectionData,
  query: string,
  limit = 10,
): SearchHit[] {
  return searchCollection(data, {
    collection: data.manifest.name,
    query,
    limit,
    includeAssets: true,
  }).filter((hit) => hit.kind === "asset");
}

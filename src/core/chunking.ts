// @ts-ignore TS2691: Pi loads the TypeScript extension source through its Jiti loader.
import { stableId } from "./provenance.ts";
// @ts-ignore TS2691: Pi loads the TypeScript extension source through its Jiti loader.
import type { ChunkRecord, Locator } from "./types.ts";

export function splitText(
  text: string,
  maxChars: number,
  overlapChars: number,
): string[] {
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .trim();
  if (!normalized) return [];
  const size = Math.max(1, Math.floor(maxChars));
  const overlap = Math.min(Math.max(0, Math.floor(overlapChars)), size - 1);
  const result: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(normalized.length, start + size);
    let boundary = end;
    if (end < normalized.length) {
      const paragraph = normalized.lastIndexOf("\n\n", end);
      const sentence = normalized.lastIndexOf("。", end);
      const whitespace = normalized.lastIndexOf(" ", end);
      boundary = Math.max(
        start + Math.floor(size * 0.55),
        paragraph,
        sentence + 1,
        whitespace,
      );
      boundary = Math.min(end, boundary);
    }
    const part = normalized.slice(start, boundary).trim();
    if (part) result.push(part);
    if (boundary >= normalized.length) break;
    start = Math.max(start + 1, boundary - overlap);
  }
  return result;
}

export function createChunks(
  documentId: string,
  collection: string,
  text: string,
  locator: Locator,
  maxChars: number,
  overlapChars: number,
): ChunkRecord[] {
  return splitText(text, maxChars, overlapChars).map((part, ordinal) => ({
    id: stableId(documentId, "chunk", String(ordinal), part),
    documentId,
    collection,
    ordinal,
    text: part,
    locator,
    metadata: {},
  }));
}

export function lexicalScore(query: string, text: string): number {
  const terms = query
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter(Boolean);
  if (terms.length === 0) return 0;
  const haystack = text.toLocaleLowerCase();
  let score = 0;
  for (const term of terms) {
    let from = 0;
    while (true) {
      const index = haystack.indexOf(term, from);
      if (index < 0) break;
      score += 1;
      from = index + term.length;
    }
  }
  return score / terms.length;
}

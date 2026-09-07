/** Lossless source spans (UTF-16 offsets), with page-local retrieval overlap.
 * No trimming/normalization: union of spans covers the exact input, including whitespace.
 */
export interface RetrievalChunk { start: number; end: number; text: string }
export function chunkRetrievalText(text: string): RetrievalChunk[] {
  const chunks: RetrievalChunk[] = [];
  const safe = (offset: number) => offset > 0 && offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset]!)
    ? offset - 1 : offset;
  let start = 0;
  while (start < text.length) {
    let end = text.length;
    if (end - start > 1200) {
      const low = start + 600, high = Math.min(start + 1200, text.length);
      end = safe(start + 800);
      // Prefer paragraph, then newline, then sentence ends nearest the target.
      for (const pattern of [/\n\s*\n/g, /\n/g, /(?:[。！？]|[.!?](?:\s+|$))/g]) {
        const candidates = [...text.slice(low, high).matchAll(pattern)]
          .map((m) => low + m.index! + m[0].length);
        if (candidates.length) {
          end = safe(candidates.sort((a, b) => Math.abs(a - start - 800) - Math.abs(b - start - 800) || a - b)[0]!);
          break;
        }
      }
    }
    chunks.push({ start, end, text: text.slice(start, end) });
    if (chunks.length > 5000) throw new Error("Retrieval element budget exceeded");
    if (end === text.length) break;
    start = safe(end - 100);
  }
  return chunks;
}

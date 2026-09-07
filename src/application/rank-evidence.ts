import type { CapturedDocument, SearchHit } from "../domain/retrieval.ts";

/** Versioned lexical representation: Latin identifiers plus Han unigrams/bigrams. */
export function tokenize(value: string): string[] {
  const result: string[] = [];
  for (const match of value
    .toLowerCase()
    .matchAll(/[\p{Script=Han}]+|[\p{L}\p{N}_]+/gu)) {
    const word = match[0];
    if (/^\p{Script=Han}+$/u.test(word)) {
      const chars = [...word];
      result.push(...chars);
      for (let i = 0; i + 1 < chars.length; i++)
        result.push(chars[i]! + chars[i + 1]!);
    } else result.push(word);
  }
  return result;
}

export function lexicalRank(
  documents: CapturedDocument[],
  query: string,
): SearchHit[] {
  const rows = documents.flatMap((document) =>
    document.elements.map((element) => ({
      document,
      element,
      tokens: tokenize(element.text),
    })),
  );
  const terms = [...new Set(tokenize(query))];
  const average =
    rows.reduce((sum, row) => sum + row.tokens.length, 0) /
      (rows.length || 1) || 1;
  const frequency = new Map(
    terms.map((term) => [
      term,
      rows.filter((row) => row.tokens.includes(term)).length,
    ]),
  );
  return rows
    .map((row) => {
      let score = 0;
      for (const term of terms) {
        const tf = row.tokens.filter((token) => token === term).length;
        const df = frequency.get(term) ?? 0;
        const idf = Math.log(1 + (rows.length - df + 0.5) / (df + 0.5));
        score +=
          (idf * tf * 2.2) /
          (tf + 1.2 * (0.25 + (0.75 * row.tokens.length) / average));
      }
      return { document: row.document, element: row.element, score };
    })
    .filter((row) => row.score > 0)
    .sort(
      (a, b) => b.score - a.score || a.element.id.localeCompare(b.element.id),
    );
}

export function cosine(left: number[], right: number[]): number {
  if (left.length !== right.length || !left.length)
    throw new Error("Embedding dimension mismatch");
  if (
    left.some((value) => !Number.isFinite(value)) ||
    right.some((value) => !Number.isFinite(value))
  )
    throw new Error("Non-finite embedding");
  const scaleA = left.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  const scaleB = right.reduce(
    (max, value) => Math.max(max, Math.abs(value)),
    0,
  );
  if (scaleA === 0 || scaleB === 0) throw new Error("Zero embedding");
  let dot = 0,
    a = 0,
    b = 0;
  for (let i = 0; i < left.length; i++) {
    const x = left[i]! / scaleA,
      y = right[i]! / scaleB;
    dot += x * y;
    a += x * x;
    b += y * y;
  }
  const score = dot / Math.sqrt(a * b);
  if (!Number.isFinite(score)) throw new Error("Invalid cosine result");
  return Math.max(-1, Math.min(1, score));
}

/** Independent candidate lists: semantic-only hits are not filtered by lexical evidence. */
export function reciprocalRankFusion(
  lexical: SearchHit[],
  dense: SearchHit[],
  limit: number,
): SearchHit[] {
  const hits = new Map<string, SearchHit>();
  for (const [kind, list] of [
    ["lexicalRank", lexical],
    ["denseRank", dense],
  ] as const) {
    list.slice(0, 50).forEach((hit, index) => {
      const key = `${hit.document.id}:${hit.document.revision}:${hit.element.id}`;
      const current = hits.get(key) ?? { ...hit, score: 0 };
      current.score += 1 / (60 + index + 1);
      current[kind] = index + 1;
      hits.set(key, current);
    });
  }
  return [...hits.values()]
    .sort(
      (a, b) => b.score - a.score || a.element.id.localeCompare(b.element.id),
    )
    .slice(0, limit);
}

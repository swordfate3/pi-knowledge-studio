import type { SearchHit } from "../domain/retrieval.ts";
import type { Reranker } from "../ports/reranker.ts";

function freezeSnapshot(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object")
      freezeSnapshot(child, seen);
  }
  Object.freeze(value);
}

/** Reranking changes order/score only, never the host's evidence or citations. */
export async function rerankEvidence(
  query: string,
  hits: SearchHit[],
  reranker: Reranker,
  limit: number,
): Promise<SearchHit[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10)
    throw new Error("Invalid rerank limit: expected an integer from 1 to 10");

  // Detach all nested citation/source data before invoking untrusted async code.
  const snapshot = structuredClone(hits.slice(0, 30));
  freezeSnapshot(snapshot);
  if (!snapshot.length) return [];
  const candidates = Object.freeze(
    snapshot.map((hit, index) =>
      Object.freeze({ id: `candidate-${index}`, text: hit.element.text }),
    ),
  );
  const indices = new Map<string, number>(
    candidates.map((candidate, index) => [candidate.id, index]),
  );
  const output = await reranker.rerank(query, candidates);
  if (!Array.isArray(output) || output.length !== snapshot.length)
    throw new Error("Invalid rerank output: expected a full permutation");

  const scores = new Map<number, number>();
  for (const row of output) {
    if (row === null || typeof row !== "object")
      throw new Error("Invalid rerank output row");
    // Read only the scoring contract; provider evidence and other fields are ignored.
    const { id, score } = row;
    const index = typeof id === "string" ? indices.get(id) : undefined;
    if (index === undefined || scores.has(index) || !Number.isFinite(score))
      throw new Error(
        "Invalid rerank output: unknown/duplicate ID or non-finite score",
      );
    scores.set(index, score);
  }
  return snapshot
    .map((hit, index) => ({ hit, index, score: scores.get(index)! }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ hit, score }) => ({ ...hit, score }));
}

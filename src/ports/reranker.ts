/** Optional reranking boundary; implementations receive no citation/source metadata. */
export interface Reranker {
  rerank(
    query: string,
    candidates: readonly { id: string; text: string }[],
  ): Promise<readonly { id: string; score: number }[]>;
}

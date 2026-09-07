import { createHash } from "node:crypto";
import type { Reranker } from "../../ports/reranker.ts";
import { boundedJsonPost } from "./http-embedding.ts";

/** Optional Cohere-style protocol adapter, not a universal reranking API. */
export interface HttpRerankerOptions {
  /** Exact POST URL, including /rerank (or the host's equivalent route). */
  endpoint: string;
  model: string;
  /** Host-declared revision for consent/traceability; not verified by this API. */
  revision: string;
  apiKey?: string;
  /** Explicit consent to send query and candidate text to this exact configuration. */
  approved: boolean;
  /** Uses boundedJsonPost's deadline and byte budgets; no retries or fallback. */
  timeoutMs?: number;
}

export interface HttpRerankerIdentity {
  readonly protocol: "cohere-rerank";
  readonly endpoint: string;
  readonly model: string;
  readonly revision: string;
  /** SHA-256 of public model/protocol configuration. Excludes credentials and deadline. */
  readonly fingerprint: string;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid rerank response object");
  return value as Record<string, unknown>;
}

export class HttpReranker implements Reranker {
  readonly identity: HttpRerankerIdentity;
  readonly #config: Readonly<HttpRerankerOptions>;

  constructor(options: HttpRerankerOptions) {
    const copied = structuredClone(options);
    let url: URL;
    try {
      url = new URL(copied.endpoint);
    } catch {
      throw new Error("Invalid reranker endpoint");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      (url.protocol === "http:" &&
        !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    )
      throw new Error("Invalid reranker endpoint");
    if (
      typeof copied.model !== "string" ||
      !copied.model.trim() ||
      typeof copied.revision !== "string" ||
      !copied.revision.trim() ||
      (copied.apiKey !== undefined && typeof copied.apiKey !== "string")
    )
      throw new Error("Invalid reranker identity");
    const timeoutMs = copied.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180_000)
      throw new Error("Invalid reranker timeoutMs");
    this.#config = Object.freeze({ ...copied, endpoint: url.href, timeoutMs });
    const identity = {
      protocol: "cohere-rerank" as const,
      endpoint: url.href,
      model: copied.model,
      revision: copied.revision,
    };
    this.identity = Object.freeze({
      ...identity,
      fingerprint: createHash("sha256")
        .update(JSON.stringify(identity))
        .digest("hex"),
    });
    Object.freeze(this);
  }

  async rerank(
    query: string,
    candidates: readonly { id: string; text: string }[],
  ): Promise<readonly { id: string; score: number }[]> {
    if (this.#config.approved !== true)
      throw new Error("Reranker egress is not approved");
    if (
      typeof query !== "string" ||
      query.length < 1 ||
      query.length > 8000 ||
      !Array.isArray(candidates) ||
      candidates.length > 30
    )
      throw new Error("Reranker input budget exceeded");
    // Capture host IDs before awaiting transport; returned documents/IDs have no authority.
    const snapshot = Array.from(candidates, (candidate) => {
      if (
        !candidate ||
        typeof candidate.id !== "string" ||
        !candidate.id ||
        typeof candidate.text !== "string" ||
        candidate.text.length > 30000
      )
        throw new Error("Invalid reranker candidate");
      return { id: candidate.id, text: candidate.text };
    });
    if (new Set(snapshot.map(({ id }) => id)).size !== snapshot.length)
      throw new Error("Duplicate reranker candidate ID");
    if (!snapshot.length) return [];
    const response = object(
      await boundedJsonPost(
        this.#config.endpoint,
        {
          model: this.#config.model,
          query,
          documents: snapshot.map(({ text }) => text),
          top_n: snapshot.length,
          return_documents: false,
        },
        this.#config.apiKey,
        { timeoutMs: this.#config.timeoutMs },
      ),
    );
    if (
      !Array.isArray(response.results) ||
      response.results.length !== snapshot.length
    )
      throw new Error("Invalid rerank response: expected a full permutation");
    const seen = new Set<number>();
    return response.results.map((value: unknown) => {
      const row = object(value);
      const { index, relevance_score: score } = row;
      if (
        typeof index !== "number" ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= snapshot.length ||
        seen.has(index) ||
        typeof score !== "number" ||
        !Number.isFinite(score)
      )
        throw new Error("Invalid rerank index or score");
      seen.add(index);
      return { id: snapshot[index]!.id, score };
    });
  }
}

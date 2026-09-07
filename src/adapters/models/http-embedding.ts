import type {
  EmbeddingProvider,
  EmbeddingSpace,
} from "../../domain/retrieval.ts";

export interface HttpEmbeddingOptions {
  endpoint: string;
  kind: "wemm" | "openai";
  space: EmbeddingSpace;
  apiKey?: string;
  /** Must be granted by a trusted caller for this exact endpoint and payload category. */
  approved: boolean;
  allowedPurposes?: readonly ("query" | "document")[];
}

function modelUrl(endpoint: string): URL {
  try {
    return new URL(endpoint);
  } catch {
    throw new Error("Invalid model endpoint URL");
  }
}

/** Closed, content-free diagnostics. Unknown measurements are omitted. */
export interface ModelTelemetryEvent {
  operation: "transport" | "answer";
  phase: "prepare" | "fetch" | "headers" | "body" | "envelope-json" | "completion" | "answer-json" | "validation" | "complete";
  outcome: "success" | "error" | "timeout";
  elapsedMs: number;
  requestBytes?: number;
  responseBytes?: number;
  status?: number;
  fetchMs?: number;
  headersMs?: number;
  firstBodyByteMs?: number;
  bodyCompleteMs?: number;
  envelopeParsedMs?: number;
  validationMs?: number;
  finishReason?: "stop" | "length" | "tool_calls" | "content_filter" | "function_call" | "other";
  usage?: Readonly<Partial<Record<"prompt_tokens" | "completion_tokens" | "total_tokens" | "reasoning_tokens" | "cached_tokens", number>>>;
  coverage?: Readonly<import("../../application/validate-answer.ts").AnswerCoverageDiagnostics>;
}
export type ModelTelemetryObserver = (event: Readonly<ModelTelemetryEvent>) => void | Promise<void>;

/** Never await observers or forward errors/content to them. */
export function observeModel(observer: ModelTelemetryObserver | undefined, event: ModelTelemetryEvent): void {
  if (!observer) return;
  try {
    const copy = structuredClone(event);
    if (copy.usage) Object.freeze(copy.usage);
    if (copy.coverage) Object.freeze(copy.coverage);
    const pending = observer(Object.freeze(copy));
    if (pending) void Promise.resolve(pending).catch(() => {});
  } catch { /* Diagnostics cannot replace operation results. */ }
}

export async function boundedJsonPost(
  endpoint: string,
  body: unknown,
  apiKey?: string,
  options: { timeoutMs?: number | undefined; observer?: ModelTelemetryObserver | undefined } = {},
): Promise<unknown> {
  const started = performance.now();
  const event: ModelTelemetryEvent = { operation: "transport", phase: "prepare", outcome: "error", elapsedMs: 0 };
  let signal: AbortSignal | undefined;
  const timeoutMs = options.timeoutMs === undefined ? 30_000 : options.timeoutMs;
  const observer = options.observer;
  try {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180_000)
      throw new Error(
        "Invalid model timeoutMs: expected an integer from 1 to 180000",
      );
    const url = modelUrl(endpoint);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error("Invalid model endpoint");
    if (
      url.protocol === "http:" &&
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
      throw new Error("Non-loopback model endpoints require HTTPS");
    const encoded = JSON.stringify(body);
    event.requestBytes = Buffer.byteLength(encoded);
    if (event.requestBytes > 4 * 1024 * 1024)
      throw new Error("Model request exceeds budget");
    signal = AbortSignal.timeout(timeoutMs);
    event.phase = "fetch";
    event.fetchMs = performance.now() - started;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: encoded,
      redirect: "error",
      signal,
    });
    event.headersMs = performance.now() - started;
    event.status = response.status;
    event.phase = "headers";
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Model HTTP ${response.status}`);
    }
    if (!response.body) throw new Error("Missing model response");
    event.phase = "body";
    event.responseBytes = 0;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (part.value.length && event.firstBodyByteMs === undefined) event.firstBodyByteMs = performance.now() - started;
        size += part.value.length;
        event.responseBytes = size;
        if (size > 8 * 1024 * 1024)
          throw new Error("Model response exceeds budget");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {
        // Cleanup must not replace a transport or response-budget error.
      });
      reader.releaseLock();
    }
    event.bodyCompleteMs = performance.now() - started;
    event.phase = "envelope-json";
    try {
      const result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      event.envelopeParsedMs = performance.now() - started;
      event.phase = "complete";
      event.outcome = "success";
      return result;
    } catch {
      throw new Error("Invalid model response JSON");
    }
  } catch (error) {
    if (signal?.aborted) {
      event.outcome = "timeout";
      throw new Error(`Model request timed out after ${timeoutMs} ms`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    event.elapsedMs = performance.now() - started;
    observeModel(observer, event);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid model response object");
  return value as Record<string, unknown>;
}

export class HttpEmbeddingProvider implements EmbeddingProvider {
  readonly options: HttpEmbeddingOptions;
  readonly space: EmbeddingSpace;
  constructor(options: HttpEmbeddingOptions) {
    const copied = structuredClone(options);
    const endpoint = modelUrl(copied.endpoint).href;
    this.space = Object.freeze({
      ...copied.space,
      provider: `${copied.space.provider}|${copied.kind}|${endpoint}`,
    });
    this.options = Object.freeze({
      ...copied,
      endpoint,
      space: this.space,
      allowedPurposes: Object.freeze([
        ...(copied.allowedPurposes ?? ["query", "document"]),
      ]),
    });
    if (
      !Number.isInteger(this.space.dimension) ||
      this.space.dimension < 1 ||
      this.space.dimension > 8192 ||
      !this.space.model ||
      !this.space.revision
    )
      throw new Error("Invalid embedding identity");
  }
  async embed(
    texts: string[],
    purpose: "query" | "document",
  ): Promise<number[][]> {
    if (
      !this.options.approved ||
      !this.options.allowedPurposes?.includes(purpose)
    )
      throw new Error("Embedding egress purpose is not approved");
    if (
      texts.length < 1 ||
      texts.length > 32 ||
      texts.some((text) => typeof text !== "string" || text.length > 32768)
    )
      throw new Error("Embedding input budget exceeded");
    const instruction =
      purpose === "query"
        ? this.space.queryInstruction
        : this.space.documentInstruction;
    const input = texts.map((text) => instruction + text);
    if (input.some((text) => text.length > 32768))
      throw new Error("Embedding input with instruction exceeds budget");
    const payload =
      this.options.kind === "wemm"
        ? { texts: input, dimension: this.space.dimension }
        : { model: this.space.model, input };
    const response = object(
      await boundedJsonPost(
        this.options.endpoint,
        payload,
        this.options.apiKey,
      ),
    );
    let raw: unknown;
    if (this.options.kind === "wemm") {
      if (
        response.model_id !== this.space.model ||
        response.model_revision !== this.space.revision ||
        response.dimension !== this.space.dimension
      )
        throw new Error("WeMM model identity mismatch");
      raw = response.embeddings;
    } else {
      if (response.model !== this.space.model)
        throw new Error("Embedding model identity mismatch");
      if (!Array.isArray(response.data))
        throw new Error("Missing embedding data");
      const rows = response.data
        .map(object)
        .sort((a, b) => Number(a.index) - Number(b.index));
      if (rows.some((row, index) => row.index !== index))
        throw new Error("Invalid embedding indices");
      raw = rows.map((row) => row.embedding);
    }
    if (!Array.isArray(raw) || raw.length !== texts.length)
      throw new Error("Embedding count mismatch");
    return raw.map((vector) => {
      if (
        !Array.isArray(vector) ||
        vector.length !== this.space.dimension ||
        vector.some(
          (value) => typeof value !== "number" || !Number.isFinite(value),
        ) ||
        !vector.some((value) => value !== 0)
      )
        throw new Error("Invalid embedding vector");
      return vector as number[];
    });
  }
}

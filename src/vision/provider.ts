// @ts-ignore TS2691: Pi loads the TypeScript extension source through its Jiti loader.
import type { StudioConfig } from "../config.ts";
// @ts-ignore TS2691: Pi loads the TypeScript extension source through its Jiti loader.
import { readRegularFileWithin } from "../core/path-safety.ts";

export interface VisionRequest {
  prompt: string;
  imagePath: string;
  /** Safe root for descriptor-relative, symlink-resistant reads. */
  imageRoot: string;
}
export interface VisionProvider {
  explain(
    request: VisionRequest,
    signal?: AbortSignal,
  ): Promise<{ text: string; model?: string }>;
}

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const IMAGE_SIGNATURES: readonly {
  mimeType: string;
  matches: (bytes: Uint8Array) => boolean;
}[] = [
  {
    mimeType: "image/png",
    matches: (b) =>
      startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  { mimeType: "image/jpeg", matches: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  {
    mimeType: "image/gif",
    matches: (b) => ascii(b, "GIF87a") || ascii(b, "GIF89a"),
  },
  {
    mimeType: "image/webp",
    matches: (b) => ascii(b, "RIFF") && ascii(b.subarray(8), "WEBP"),
  },
  { mimeType: "image/bmp", matches: (b) => ascii(b, "BM") },
];

export class OpenAICompatibleVisionProvider implements VisionProvider {
  public constructor(private readonly config: StudioConfig) {}

  public async explain(
    request: VisionRequest,
    signal?: AbortSignal,
  ): Promise<{ text: string; model?: string }> {
    if (!this.config.visionBaseUrl || !this.config.visionModel)
      throw new Error(
        "Vision is not configured. Set PI_KNOWLEDGE_STUDIO_VISION_BASE_URL and PI_KNOWLEDGE_STUDIO_VISION_MODEL.",
      );

    const endpoint = parseVisionEndpoint(this.config.visionBaseUrl);
    const explicitVisionKey = process.env.PI_KNOWLEDGE_STUDIO_VISION_API_KEY;
    if (
      this.config.visionApiKey &&
      !explicitVisionKey &&
      process.env.OPENAI_API_KEY === this.config.visionApiKey &&
      !isOpenAIEndpoint(endpoint)
    ) {
      throw new Error(
        "Refusing to send OPENAI_API_KEY to a non-OpenAI vision endpoint. Set PI_KNOWLEDGE_STUDIO_VISION_API_KEY explicitly for this endpoint.",
      );
    }

    const image = await readValidatedImage(
      request.imagePath,
      request.imageRoot,
      this.config.maxAssetBytes,
      this.config.maxVisionImagePixels,
      this.config.maxVisionRequestBytes,
    );
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const requestSignal = mergeAbortSignals(signal, timeoutSignal);
    const requestBody = JSON.stringify({
      model: this.config.visionModel,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: request.prompt },
            {
              type: "image_url",
              image_url: {
                url: `data:${image.mimeType};base64,${image.base64}`,
              },
            },
          ],
        },
      ],
    });
    if (
      Buffer.byteLength(requestBody, "utf8") > this.config.maxVisionRequestBytes
    )
      throw new Error(
        `Vision request exceeded the ${this.config.maxVisionRequestBytes}-byte limit.`,
      );
    const init: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.config.visionApiKey
          ? { authorization: `Bearer ${this.config.visionApiKey}` }
          : {}),
      },
      body: requestBody,
    };
    if (requestSignal) init.signal = requestSignal;

    const response = await fetch(new URL("chat/completions", endpoint), init);
    const responseText = await readResponseText(response);
    if (!response.ok)
      throw new Error(
        `Vision request failed with HTTP ${response.status}: ${responseText}`,
      );
    let payload: unknown;
    try {
      payload = JSON.parse(responseText) as unknown;
    } catch {
      throw new Error("Vision response was not valid JSON.");
    }
    const text = extractResponseText(payload);
    if (!text)
      throw new Error(
        "Vision response did not contain choices[0].message.content text.",
      );
    return { text, model: this.config.visionModel };
  }
}

function parseVisionEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("Vision base URL must be a valid absolute URL.");
  }
  if (!isLocalEndpoint(endpoint) && endpoint.protocol !== "https:")
    throw new Error(
      "Vision base URL must use HTTPS. HTTP is allowed only for explicit localhost development endpoints.",
    );
  if (endpoint.username || endpoint.password)
    throw new Error("Vision base URL must not contain embedded credentials.");
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/`;
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

function isLocalEndpoint(endpoint: URL): boolean {
  return (
    endpoint.protocol === "http:" &&
    (endpoint.hostname === "localhost" ||
      endpoint.hostname === "127.0.0.1" ||
      endpoint.hostname === "[::1]" ||
      endpoint.hostname === "::1")
  );
}

function isOpenAIEndpoint(endpoint: URL): boolean {
  return endpoint.hostname === "api.openai.com";
}

function mergeAbortSignals(
  signal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): AbortSignal {
  if (!signal) return timeoutSignal;
  if (signal.aborted) return signal;
  const controller = new AbortController();
  const abort = (source: AbortSignal) => controller.abort(source.reason);
  signal.addEventListener("abort", () => abort(signal), { once: true });
  timeoutSignal.addEventListener("abort", () => abort(timeoutSignal), {
    once: true,
  });
  return controller.signal;
}

async function readValidatedImage(
  path: string,
  root: string,
  maxAssetBytes: number,
  maxPixels: number,
  maxRequestBytes: number,
) {
  const bytes = await readRegularFileWithin(root, path, maxAssetBytes);
  const signature = IMAGE_SIGNATURES.find((candidate) =>
    candidate.matches(bytes),
  );
  if (!signature)
    throw new Error(
      "Vision image must be a PNG, JPEG, GIF, WebP, or BMP file.",
    );
  const dimensions = imageDimensions(signature.mimeType, bytes);
  if (
    !dimensions ||
    !Number.isSafeInteger(maxPixels) ||
    maxPixels <= 0 ||
    dimensions.width > Math.floor(maxPixels / dimensions.height)
  )
    throw new Error(
      `Vision image dimensions exceed the ${maxPixels}-pixel limit.`,
    );
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes <= 0)
    throw new Error("Vision request size limit is not configured correctly.");
  const encodedBytes = Math.ceil(bytes.byteLength / 3) * 4;
  if (encodedBytes > maxRequestBytes)
    throw new Error(
      `Vision image exceeds the ${maxRequestBytes}-byte encoded request limit.`,
    );
  return { mimeType: signature.mimeType, base64: bytes.toString("base64") };
}

type ImageDimensions = { width: number; height: number };

function imageDimensions(
  mimeType: string,
  bytes: Uint8Array,
): ImageDimensions | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mimeType === "image/png") {
    if (bytes.length < 24 || !ascii(bytes.subarray(12), "IHDR"))
      return undefined;
    return validDimensions(
      view.getUint32(16, false),
      view.getUint32(20, false),
    );
  }
  if (mimeType === "image/gif") {
    if (bytes.length < 10) return undefined;
    return validDimensions(view.getUint16(6, true), view.getUint16(8, true));
  }
  if (mimeType === "image/bmp") {
    if (bytes.length < 26) return undefined;
    return validDimensions(
      Math.abs(view.getInt32(18, true)),
      Math.abs(view.getInt32(22, true)),
    );
  }
  if (mimeType === "image/webp") return webpDimensions(bytes);
  if (mimeType === "image/jpeg") return jpegDimensions(bytes);
  return undefined;
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 30 && ascii(bytes.subarray(12), "VP8X")) {
    const width =
      1 +
      (view.getUint8(24) |
        (view.getUint8(25) << 8) |
        (view.getUint8(26) << 16));
    const height =
      1 +
      (view.getUint8(27) |
        (view.getUint8(28) << 8) |
        (view.getUint8(29) << 16));
    return validDimensions(width, height);
  }
  if (bytes.length >= 30 && ascii(bytes.subarray(12), "VP8 ")) {
    if (!startsWith(bytes.subarray(23), [0x9d, 0x01, 0x2a])) return undefined;
    return validDimensions(
      view.getUint16(26, true) & 0x3fff,
      view.getUint16(28, true) & 0x3fff,
    );
  }
  if (
    bytes.length >= 25 &&
    ascii(bytes.subarray(12), "VP8L") &&
    view.getUint8(20) === 0x2f
  ) {
    const width = 1 + ((view.getUint8(21) | (view.getUint8(22) << 8)) & 0x3fff);
    const height =
      1 +
      (((view.getUint8(22) >> 6) |
        (view.getUint8(23) << 2) |
        (view.getUint8(24) << 10)) &
        0x3fff);
    return validDimensions(width, height);
  }
  return undefined;
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 4) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (view.getUint8(offset) !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && view.getUint8(offset) === 0xff) offset += 1;
    if (offset >= bytes.length) return undefined;
    const marker = view.getUint8(offset++);
    if (
      marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      marker === 0x01
    )
      continue;
    if (marker === 0xd9 || marker === 0xda || offset + 1 >= bytes.length)
      return undefined;
    const length = view.getUint16(offset, false);
    if (length < 2 || offset + length > bytes.length) return undefined;
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame && length >= 7 && offset + 7 < bytes.length)
      return validDimensions(
        view.getUint16(offset + 5, false),
        view.getUint16(offset + 3, false),
      );
    offset += length;
  }
  return undefined;
}

function validDimensions(
  width: number,
  height: number,
): ImageDimensions | undefined {
  return Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0
    ? { width, height }
    : undefined;
}

async function readResponseText(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > MAX_RESPONSE_BYTES)
    throw new Error(
      `Vision response exceeded the ${MAX_RESPONSE_BYTES}-byte limit.`,
    );
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_RESPONSE_BYTES)
        throw new Error(
          `Vision response exceeded the ${MAX_RESPONSE_BYTES}-byte limit.`,
        );
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, value: string): boolean {
  return startsWith(
    bytes,
    [...value].map((character) => character.charCodeAt(0)),
  );
}

function extractResponseText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object")
    return undefined;
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}

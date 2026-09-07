import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { CapturedElement, CapturedImage } from "../../domain/retrieval.ts";
import type { BlobStore } from "../../ports/blob-store.ts";
import { createHash } from "node:crypto";
import {
  prepareImage,
  storePrepared,
  type PreparedImage,
} from "./capture-image.ts";
import { extname } from "node:path";

export const DOCX_CAPTURE_LIMITATIONS =
  "Restricted DOCX main-body paragraphs and table-cell text, with original embedded PNG/JPEG/static WebP occurrences with PNG renditions (8-bit, non-interlaced, non-palette; validated pixel/byte budgets). No general DOCX rendering: headers/footers, notes, pagination and formatting are omitted; fields, tracked revisions, text boxes, VML, alternate content, external relationships and unsupported drawings reject. Cropping, rotation and effects are not reproduced. Links mean containing paragraph, not semantic association; image-only paragraphs have no text retrieval links. JPEG/WebP also require optional sharp; EXIF orientation ignored, original metadata retained, decoder-version-bound PNG display. Python 3 is an optional required runtime for DOCX. The subprocess is resource isolation, not a sandbox; OS resource limits are platform-dependent.";

const MAX_OUTPUT = 40 * 1024 * 1024;

function runWorker(bytes: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "python3",
      ["-I", "-B", fileURLToPath(new URL("./docx-worker.py", import.meta.url))],
      {
        env: {},
        stdio: ["pipe", "pipe", "pipe"],
        cwd: fileURLToPath(new URL(".", import.meta.url)),
      },
    );
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let outputSize = 0;
    let errorSize = 0;
    let failure: Error | undefined;
    const stop = (message: string) => {
      failure ??= new Error(message);
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () => stop("DOCX parsing timeout (30 seconds)"),
      30_000,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > MAX_OUTPUT) stop("DOCX worker output budget exceeded");
      else output.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorSize += chunk.length;
      if (errorSize > 16 * 1024) stop("DOCX worker stderr budget exceeded");
      else errors.push(chunk);
    });
    child.on("error", () =>
      stop(
        "Unable to start DOCX worker: Python 3 runtime (python3) is required and the packaged docx-worker.py must be present",
      ),
    );
    child.stdin.on("error", () => {
      /* Exit status/timeout is authoritative (including early EPIPE). */
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code === 0) resolve(Buffer.concat(output));
      else
        reject(
          new Error(
            `DOCX parsing failed: ${
              Buffer.concat(errors)
                .toString("utf8")
                .replace(/[\x00-\x1f\x7f]/g, " ")
                .slice(0, 2048) || "worker exited or exceeded memory budget"
            }`,
          ),
        );
    });
    child.stdin.end(bytes);
  });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid DOCX worker object");
  return value as Record<string, unknown>;
}
function keys(value: unknown, expected: string[]): Record<string, unknown> {
  const object = record(value);
  if (
    Object.keys(object).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(object, key))
  )
    throw new Error("Invalid DOCX worker fields");
  return object;
}
function text(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ||
    /[\uD800-\uDFFF]/u.test(value)
  )
    throw new Error("Invalid DOCX worker text");
  return value;
}
async function validateOutput(output: Buffer) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(output),
    ) as unknown;
  } catch {
    throw new Error("Invalid DOCX worker JSON or UTF-8");
  }
  const root = keys(parsed, ["paragraphs", "assets"]);
  const assets = record(root.assets);
  if (Object.keys(assets).length > 100)
    throw new Error("DOCX asset count exceeded");
  const decoded = new Map<
    string,
    { data: Buffer; hash: string; prepared: PreparedImage }
  >();
  let originalBytes = 0,
    combinedBytes = 0,
    pixels = 0;
  const deadline = Date.now() + 60_000;
  for (const [path, value] of Object.entries(assets)) {
    if (
      !/^word\/media\/[A-Za-z0-9_.-]+\.(?:png|jpg|jpeg|webp)$/.test(path) ||
      path.includes("..") ||
      typeof value !== "string" ||
      value.length > 4 * Math.ceil((20 * 1024 * 1024) / 3)
    )
      throw new Error("Invalid DOCX asset encoding or name");
    const data = Buffer.from(value, "base64");
    originalBytes += data.length;
    combinedBytes += data.length;
    if (data.toString("base64") !== value || originalBytes > 20 * 1024 * 1024)
      throw new Error("Invalid DOCX asset bytes or budget");
    if (Date.now() > deadline) throw new Error("DOCX image deadline exceeded");
    const prepared = await prepareImage(data, extname(path));
    if (prepared.rendition) {
      pixels += prepared.rendition.width * prepared.rendition.height;
      combinedBytes += prepared.display.length;
    }
    if (pixels > 16_000_000 || combinedBytes > 50 * 1024 * 1024)
      throw new Error("DOCX image rendition budget exceeded");
    decoded.set(path, {
      data,
      prepared,
      hash: createHash("sha256").update(data).digest("hex"),
    });
  }
  if (!Array.isArray(root.paragraphs) || root.paragraphs.length > 5000)
    throw new Error("Invalid DOCX paragraphs");
  const elements: CapturedElement[] = [];
  const images: CapturedImage[] = [];
  const used = new Set<string>();
  let textSize = 0;
  root.paragraphs.forEach((value: unknown, index: number) => {
    const paragraph = keys(value, ["paragraph", "text", "images"]);
    if (paragraph.paragraph !== index + 1 || !Array.isArray(paragraph.images))
      throw new Error("Invalid DOCX paragraph sequence");
    const content = text(paragraph.text, 1_000_000);
    textSize += content.length;
    if (textSize > 1_000_000) throw new Error("DOCX text budget exceeded");
    const anchor = `word/document.xml#p=${index + 1}`;
    const elementIds: string[] = [];
    if (content.trim()) {
      for (let offset = 0; offset < content.length; ) {
        let end = Math.min(offset + 30_000, content.length);
        if (end < content.length && /[\uD800-\uDBFF]/u.test(content[end - 1]!))
          end--;
        const id = `element_${elements.length}`;
        elements.push({
          id,
          text: content.slice(offset, end),
          locator: { kind: "anchor", anchor },
        });
        elementIds.push(id);
        offset = end;
      }
    }
    if (elements.length > 5000) throw new Error("DOCX element budget exceeded");
    paragraph.images.forEach((value: unknown, picture: number) => {
      const image = keys(value, ["asset", "caption"]);
      if (
        typeof image.asset !== "string" ||
        !decoded.has(image.asset) ||
        images.length >= 100
      )
        throw new Error("Invalid DOCX image reference or budget");
      used.add(image.asset);
      images.push({
        id: `image_${images.length}`,
        blobHash: decoded.get(image.asset)!.hash,
        ...(decoded.get(image.asset)!.prepared.rendition
          ? { rendition: decoded.get(image.asset)!.prepared.rendition }
          : {}),
        locator: { kind: "anchor", anchor: `${anchor};picture=${picture + 1}` },
        originKind: "embedded_original",
        caption: text(image.caption, 2000),
        elementIds: [...elementIds],
      });
    });
  });
  if (used.size !== decoded.size) throw new Error("Unreferenced DOCX assets");
  if (!elements.length && !images.length)
    throw new Error("DOCX has no supported extractable content");
  return { elements, images, decoded };
}

/** All worker fields, links, budgets and original PNGs validate before any image write. */
export async function captureDocx(
  bytes: Uint8Array,
  blobs: BlobStore,
): Promise<{ elements: CapturedElement[]; images: CapturedImage[] }> {
  if (
    !(bytes instanceof Uint8Array) ||
    !bytes.length ||
    bytes.length > 20 * 1024 * 1024
  )
    throw new Error("DOCX input must contain 1 byte to 20 MiB");
  const { elements, images, decoded } = await validateOutput(
    await runWorker(bytes),
  );
  const stored = new Set<string>();
  for (const { prepared, hash } of decoded.values()) {
    if (stored.has(hash)) continue;
    await storePrepared(prepared, blobs);
    stored.add(hash);
  }
  return { elements, images };
}

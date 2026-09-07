import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, extname } from "node:path";
import {
  readRegularFileWithin,
  safeRelativeResource,
} from "../../core/path-safety.ts";
import { sha256 } from "../blob/file-blob-store.ts";
import {
  prepareImage,
  storePrepared,
  type PreparedImage,
} from "./capture-image.ts";
import type { BlobStore } from "../../ports/blob-store.ts";
import type { CapturedElement, CapturedImage } from "../../domain/retrieval.ts";

export type ValidateSourcePath = (path: string) => void | Promise<void>;
export const HTML_CAPTURE_LIMITATIONS =
  "Restricted static HTML structural text and local original PNG/JPEG/static WebP images; Python 3 required. Not browser visibility, layout or pagination. Headings, paragraphs, simple lists and tables are flattened; links are not followed, image links mean containing text block only, image-only blocks have no text links. Active content, CSS/style/link, unsupported tags/attributes and unsafe resources reject. JPEG/WebP require optional sharp; original metadata retained. Worker resource isolation is not a sandbox; OS limits are platform-dependent.";

const MAX_OUTPUT = 8 * 1024 * 1024;

function runWorker(bytes: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "python3",
      ["-I", "-B", fileURLToPath(new URL("./html-worker.py", import.meta.url))],
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
      () => stop("HTML parsing timeout (30 seconds)"),
      30_000,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > MAX_OUTPUT) stop("HTML worker output budget exceeded");
      else output.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorSize += chunk.length;
      if (errorSize > 16 * 1024) stop("HTML worker stderr budget exceeded");
      else errors.push(chunk);
    });
    child.on("error", () =>
      stop(
        "Unable to start HTML worker: Python 3 runtime (python3) is required and the packaged html-worker.py must be present",
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
            `HTML parsing failed: ${
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
    throw new Error("Invalid HTML worker object");
  return value as Record<string, unknown>;
}
function keys(value: unknown, expected: string[]): Record<string, unknown> {
  const object = record(value);
  if (
    Object.keys(object).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(object, key))
  )
    throw new Error("Invalid HTML worker fields");
  return object;
}
function text(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ||
    /[\uD800-\uDFFF]/u.test(value)
  )
    throw new Error("Invalid HTML worker text");
  return value;
}
interface HtmlBlock {
  tag: string;
  text: string;
  images: { src: string; caption: string }[];
}
export async function parseHtml(bytes: Uint8Array): Promise<HtmlBlock[]> {
  if (!bytes.length || bytes.length > 20 * 1024 * 1024)
    throw new Error("HTML source budget exceeded");
  const root = keys(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(await runWorker(bytes)),
    ) as unknown,
    ["blocks"],
  );
  if (!Array.isArray(root.blocks) || root.blocks.length > 5000)
    throw new Error("Invalid HTML blocks");
  let size = 0,
    pictures = 0;
  const blocks = root.blocks.map((value: unknown): HtmlBlock => {
    const block = keys(value, ["tag", "text", "images"]);
    const tag = text(block.tag, 10),
      content = text(block.text, 1_000_000);
    if (
      !/^(text|h[1-6]|p|li|td|th|caption)$/.test(tag) ||
      !Array.isArray(block.images)
    )
      throw new Error("Invalid HTML block");
    size += content.length;
    const images = block.images.map((value: unknown) => {
      const image = keys(value, ["src", "caption"]);
      pictures++;
      const src = text(image.src, 4096);
      if (!src) throw new Error("Invalid HTML image source");
      return { src, caption: text(image.caption, 2000) };
    });
    if (size > 1_000_000 || pictures > 100)
      throw new Error("HTML manifest budget exceeded");
    return { tag, text: content, images };
  });
  if (!blocks.some((block) => block.text.trim() || block.images.length))
    throw new Error("HTML has no supported content");
  return blocks;
}

/** Entity decoding occurs in HTMLParser; one percent decode, then strict local confinement. */
export function resolveHtmlImage(sourcePath: string, src: string): string {
  const decoded = decodeURIComponent(src);
  if (decoded !== decoded.trim() || /[\\%?#:\x00-\x20\x7f]/u.test(decoded))
    throw new Error("Unsafe HTML image resource");
  const path = safeRelativeResource(dirname(sourcePath), decoded);
  if (
    !path ||
    ![".png", ".jpg", ".jpeg", ".webp"].includes(extname(path).toLowerCase())
  )
    throw new Error("Only relative local HTML PNG/JPEG/WebP images supported");
  return path;
}

export async function captureHtml(
  bytes: Uint8Array,
  sourceRoot: string,
  sourcePath: string,
  blobs: BlobStore,
  validatePath: ValidateSourcePath = () => {},
): Promise<{ elements: CapturedElement[]; images: CapturedImage[] }> {
  const blocks = await parseHtml(bytes);
  const elements: CapturedElement[] = [],
    images: CapturedImage[] = [];
  const assets = new Map<string, PreparedImage>();
  let totalBytes = 0,
    originalBytes = 0,
    pixels = 0;
  const deadline = Date.now() + 60_000;
  for (const [index, block] of blocks.entries()) {
    const anchor = `html#block=${index + 1};tag=${block.tag}`;
    const elementIds: string[] = [];
    for (let offset = 0; offset < block.text.length; ) {
      let end = Math.min(offset + 30_000, block.text.length);
      if (
        end < block.text.length &&
        /[\uD800-\uDBFF]/u.test(block.text[end - 1]!)
      )
        end--;
      const id = `element_${elements.length}`;
      elements.push({
        id,
        text: block.text.slice(offset, end),
        locator: {
          kind: "anchor",
          anchor: `${anchor};chunk=${elementIds.length + 1}`,
        },
      });
      elementIds.push(id);
      offset = end;
      if (elements.length > 5000)
        throw new Error("HTML element budget exceeded");
    }
    for (const [picture, image] of block.images.entries()) {
      if (Date.now() > deadline)
        throw new Error("HTML image deadline exceeded");
      const path = resolveHtmlImage(sourcePath, image.src);
      await validatePath(path);
      let prepared = assets.get(path);
      if (!prepared) {
        const data = await readRegularFileWithin(
          sourceRoot,
          path,
          20 * 1024 * 1024,
        );
        totalBytes += data.length;
        originalBytes += data.length;
        if (originalBytes > 20 * 1024 * 1024)
          throw new Error("HTML original image budget exceeded");
        prepared = await prepareImage(data, extname(path));
        if (prepared.rendition) {
          pixels += prepared.rendition.width * prepared.rendition.height;
          totalBytes += prepared.display.length;
        }
        if (pixels > 16_000_000 || totalBytes > 50 * 1024 * 1024)
          throw new Error("HTML rendition budget exceeded");
        assets.set(path, prepared);
      }
      images.push({
        id: `image_${images.length}`,
        blobHash: sha256(prepared.original),
        ...(prepared.rendition ? { rendition: prepared.rendition } : {}),
        locator: { kind: "anchor", anchor: `${anchor};img=${picture + 1}` },
        originKind: "embedded_original",
        caption: image.caption,
        elementIds: [...elementIds],
      });
    }
  }
  if (Date.now() > deadline) throw new Error("HTML image deadline exceeded");
  for (const prepared of assets.values()) await storePrepared(prepared, blobs);
  return { elements, images };
}

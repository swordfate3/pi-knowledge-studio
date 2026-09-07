import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sha256 } from "../blob/file-blob-store.ts";
import { validatePng } from "../export/png.ts";
import { encodePng } from "../export/encode-png.ts";
import { validateRendition, type ImageRendition } from "../../domain/rendition.ts";
import type { BlobStore } from "../../ports/blob-store.ts";

export interface PreparedImage { original: Buffer; display: Buffer; rendition?: ImageRendition }
export const IMAGE_LIMITATIONS = "JPEG/static WebP originals retain all metadata; display is a metadata-free sRGB RGBA PNG, EXIF orientation ignored. Optional sharp with native platform packages required. JPEG uses decoder warning rejection and final EOI check, not PNG-equivalent strict container/concatenation validation. WebP requires exact RIFF length and no animation. Subprocess wall/output/heap and pixel bounds are not a native-memory sandbox or portable CPU/address-space limit.";

function decode(bytes: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=128", fileURLToPath(new URL("./image-worker.mjs", import.meta.url))], {
      env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), VIPS_CONCURRENCY: "1", MALLOC_ARENA_MAX: "2" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let size = 0, errors = 0; const output: Buffer[] = [], stderr: Buffer[] = [];
    let failure: Error | undefined;
    const stop = (message: string) => { failure ??= new Error(message); child.kill("SIGKILL"); };
    const timer = setTimeout(() => stop("Image decoder deadline exceeded (10 seconds)"), 10_000);
    child.stdout.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 16_001_024) stop("Image decoder output budget exceeded"); else output.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.length; if (errors > 4096) stop("Image decoder error budget exceeded"); else stderr.push(chunk); });
    child.on("error", () => stop("Unable to start optional sharp image decoder"));
    child.stdin.on("error", () => {});
    child.on("close", code => { clearTimeout(timer); if (failure) reject(failure); else if (code === 0) resolve(Buffer.concat(output));  else reject(new Error(`Image decoder failed: ${Buffer.concat(stderr).toString().replace(/[\x00-\x1f]/g, " ")}`)); });
    child.stdin.end(bytes);
  });
}

/** No writes. PNG pass-through deliberately keeps legacy capture identity. */
export async function prepareImage(input: Uint8Array, extension?: string): Promise<PreparedImage> {
  const original = Buffer.from(input);
  if (!original.length || original.length > 20 * 1024 * 1024) throw new Error("Image input budget exceeded");
  let mediaType: string;
  if (original.subarray(0,8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) mediaType = "image/png";
  else if (original[0] === 255 && original[1] === 216) mediaType = "image/jpeg";
  else if (original.toString("ascii",0,4) === "RIFF" && original.toString("ascii",8,12) === "WEBP") mediaType = "image/webp";
  else throw new Error("Unsupported image format (PNG/JPEG/WebP required)");
  if (extension && ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" } as Record<string,string>)[extension.toLowerCase()] !== mediaType) throw new Error("Image extension/format mismatch");
  if (mediaType === "image/png") { validatePng(original); return { original, display: original }; }
  if (mediaType === "image/jpeg" && (original.at(-2) !== 255 || original.at(-1) !== 217)) throw new Error("JPEG missing final EOI (truncated or trailing data)");
  if (mediaType === "image/webp") {
    if (original.length < 20 || original.readUInt32LE(4) + 8 !== original.length) throw new Error("WebP RIFF length mismatch");
    let offset = 12;
    while (offset < original.length) {
      if (offset + 8 > original.length) throw new Error("Truncated WebP chunk");
      const kind = original.toString("ascii", offset, offset+4), length = original.readUInt32LE(offset+4);
      if (kind === "ANIM" || kind === "ANMF" || (kind === "VP8X" && (original[offset+8]! & 2))) throw new Error("Animated WebP unsupported");
      offset += 8 + length + (length % 2);
      if (offset > original.length) throw new Error("Truncated WebP payload");
    }
  }
  const result = await decode(original), newline = result.indexOf(10);
  if (newline < 0 || newline > 1024) throw new Error("Invalid image decoder header");
  const header = JSON.parse(result.subarray(0,newline).toString()) as Record<string,unknown>;
  if (Object.keys(header).sort().join() !== "height,mediaType,recipe,width" || header.mediaType !== mediaType) throw new Error("Invalid image decoder metadata");
  const display = encodePng(header.width as number, header.height as number, 4, result.subarray(newline+1));
  const rendition = { mediaType: "image/png", sourceMediaType: mediaType, blobHash: sha256(display), width: header.width, height: header.height, recipe: header.recipe };
  validateRendition(rendition);
  return { original, display, rendition };
}

export async function storePrepared(image: PreparedImage, blobs: BlobStore): Promise<void> {
  for (const bytes of image.rendition ? [image.original, image.display] : [image.original])
    if (await blobs.put(bytes) !== sha256(bytes)) throw new Error("Image blob integrity mismatch");
}

/** Public trust boundary: re-decode, not just hash-check a caller's claimed association. */
export async function verifiedDisplay(image: { blobHash: string; rendition?: ImageRendition }, blobs: BlobStore): Promise<PreparedImage> {
  const bytes = Buffer.from(await blobs.get(image.blobHash));
  if (sha256(bytes) !== image.blobHash) throw new Error("Export image integrity mismatch");
  if (!image.rendition) { validatePng(bytes); return { original: bytes, display: bytes }; }
  validateRendition(image.rendition);
  const prepared = await prepareImage(bytes);
  const r = prepared.rendition;
  if (!r || Object.keys(r).some(key => r[key as keyof ImageRendition] !== image.rendition![key as keyof ImageRendition])) throw new Error("Image rendition relationship mismatch (decoder recipe must match)");
  const display = Buffer.from(await blobs.get(r.blobHash));
  if (sha256(display) !== r.blobHash || !display.equals(prepared.display)) throw new Error("Image rendition integrity mismatch");
  validatePng(display);
  return prepared;
}

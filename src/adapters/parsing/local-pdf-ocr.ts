import { spawn } from "node:child_process";
import {
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, parse, sep } from "node:path";
import { readRegularFileWithin } from "../../core/path-safety.ts";
import { sha256 } from "../blob/file-blob-store.ts";
import { validatePng } from "../export/png.ts";
import {
  OCR_PARSER,
  OCR_RECIPE,
  OCR_WARNING,
  type OcrPage,
} from "../../domain/ocr.ts";
import type { CapturedElement, CapturedImage } from "../../domain/retrieval.ts";
import type { BlobStore } from "../../ports/blob-store.ts";

export interface OcrOptions {
  approved: boolean;
  configPath: string;
  signal?: AbortSignal | undefined;
}
/** Observe either public cancellation entry point throughout the ingestion lifecycle. */
export function effectiveOcrSignal(
  outer?: AbortSignal,
  nested?: AbortSignal,
): AbortSignal | undefined {
  return outer && nested && outer !== nested
    ? AbortSignal.any([outer, nested])
    : outer ?? nested;
}

/** Conservative pathname preflight, NOT descriptor anchoring or an OS sandbox.
 * Root/current-user directory owners are trusted. Sticky shared ancestors such
 * as /tmp are allowed; same-user changes and post-check races remain trusted.
 */
export async function validateOcrTempRoot(path: string): Promise<void> {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))
    throw new Error("OCR_STACK_MISMATCH: invalid temp root path");
  const root = parse(path).root;
  const parts = path.slice(root.length).split(sep).filter(Boolean);
  if (parts.some(part => part === "." || part === ".."))
    throw new Error("OCR_STACK_MISMATCH: non-canonical temp root path");
  let current = root;
  for (const part of ["", ...parts]) {
    if (part) current = join(current, part);
    const info = await lstat(current);
    if (
      info.isSymbolicLink() || !info.isDirectory() ||
      (info.uid !== 0 && info.uid !== process.getuid?.()) ||
      ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)
    )
      throw new Error("OCR_STACK_MISMATCH: unsafe temp root ancestor");
  }
  await owned(path, true);
}

interface Pin {
  path: string;
  name: string;
  sha256: string;
}
interface Config {
  version: 1;
  platform: "linux-x64";
  tempRoot: string;
  files: Pin[];
}
const exact = (value: Config | Pin, keys: string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((k) => Object.hasOwn(value, k));
async function owned(path: string, directory = false) {
  if (!isAbsolute(path) || path.includes("\0"))
    throw new Error("OCR_UNAVAILABLE: absolute host paths required");
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    (directory ? !info.isDirectory() : !info.isFile()) ||
    info.uid !== process.getuid?.() ||
    info.mode & (directory ? 0o077 : 0o022)
  )
    throw new Error(
      "OCR_STACK_MISMATCH: stack/config must be owned and non-writable by others; temp root owner-only",
    );
}
async function load(path: string): Promise<{
  config: Config;
  fingerprint: string;
  pinned: Map<string, Buffer>;
}> {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("OCR_UNAVAILABLE: Linux x64 required");
  await owned(path);
  const raw = await readRegularFileWithin("/", path, 128 * 1024);
  const c = JSON.parse(raw.toString()) as Config;
  if (
    !c ||
    !exact(c, ["version", "platform", "tempRoot", "files"]) ||
    c.version !== 1 ||
    c.platform !== "linux-x64" ||
    !Array.isArray(c.files) ||
    c.files.length > 150
  )
    throw new Error("OCR_STACK_MISMATCH: invalid config");
  await validateOcrTempRoot(c.tempRoot);
  const pinned = new Map<string, Buffer>();
  let total = 0;
  for (const f of c.files) {
    if (
      !f ||
      !exact(f, ["path", "name", "sha256"]) ||
      typeof f.name !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.+-]{0,127}$/.test(f.name) ||
      pinned.has(f.name) ||
      !/^[a-f0-9]{64}$/.test(f.sha256)
    )
      throw new Error("OCR_STACK_MISMATCH: invalid pin");
    await owned(f.path);
    const bytes = await readRegularFileWithin("/", f.path, 50 * 1024 * 1024);
    total += bytes.length;
    if (total > 256 * 1024 * 1024 || sha256(bytes) !== f.sha256)
      throw new Error("OCR_STACK_MISMATCH: bytes differ from host pins");
    pinned.set(f.name, bytes);
  }
  for (const name of [
    "loader",
    "pdftoppm",
    "pdfinfo",
    "tesseract",
    "eng.traineddata",
    "chi_sim.traineddata",
    "fallback-font.ttc",
  ])
    if (!pinned.has(name))
      throw new Error("OCR_UNAVAILABLE: missing binary/loader/language pin");
  return {
    config: c,
    pinned,
    fingerprint: sha256(
      JSON.stringify(c.files.map((f) => [f.name, f.sha256]).sort()),
    ),
  };
}
/** Fixed commands, bounded diagnostics/file polling and process-group kill; NOT an OS sandbox. */
async function command(
  stack: string,
  dir: string,
  name: string,
  args: string[],
  deadline: number,
  signal?: AbortSignal,
  inspect = false,
): Promise<string> {
  signal?.throwIfAborted();
  if (Date.now() >= deadline) throw new Error("OCR_TIMEOUT");
  return new Promise((resolve, reject) => {
    const child = spawn(
      join(stack, "loader"),
      [
        "--inhibit-cache",
        "--library-path",
        stack,
        ...(inspect ? ["--list"] : []),
        join(stack, name),
        ...args,
      ],
      {
        shell: false,
        detached: true,
        cwd: dir,
        env: {
          LANG: "C",
          LC_ALL: "C",
          HOME: dir,
          TMPDIR: dir,
          OMP_THREAD_LIMIT: "2",
          FONTCONFIG_PATH: dir,
          FONTCONFIG_FILE: join(dir, "fonts.conf"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let failure: Error | undefined,
      output = "",
      size = 0,
      polling = false;
    const kill = (error: Error) => {
      failure ??= error;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already exited */
        }
      }
    };
    const abort = () => kill(new Error("OCR_CANCELLED"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(
      () => kill(new Error("OCR_TIMEOUT")),
      Math.min(30_000, deadline - Date.now()),
    );
    const poll = setInterval(() => {
      if (polling) return;
      polling = true;
      void (async () => {
        for (const file of await readdir(dir)) {
          const info = await lstat(join(dir, file));
          if (
            info.isFile() &&
            info.size >
              (file.endsWith(".png")
                ? 8 * 1024 * 1024
                : file.endsWith(".txt")
                  ? 400_000
                  : 20 * 1024 * 1024)
          )
            kill(new Error("OCR_BUDGET_EXCEEDED: subprocess output"));
        }
      })()
        .catch(() =>
          kill(new Error("OCR_UNAVAILABLE: output inspection failed")),
        )
        .finally(() => {
          polling = false;
        });
    }, 50);
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (data: Buffer) => {
        size += data.length;
        if (size > 16_384) kill(new Error("OCR_BUDGET_EXCEEDED: diagnostics"));
        else output += data.toString("utf8");
      });
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearInterval(poll);
      signal?.removeEventListener("abort", abort);
      // Kill descendants even if the leader exited normally.
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* reaped */
        }
      }
      if (failure) reject(failure);
      else if (code === 0) resolve(output);
      else
        reject(
          new Error(
            `OCR_UNAVAILABLE: ${name} failed (exit ${code}); check PDF and pinned dependencies`,
          ),
        );
    });
  });
}
export async function captureOcrPdf(
  bytes: Uint8Array,
  blobs: BlobStore,
  options: OcrOptions,
) {
  if (options.approved !== true) throw new Error("OCR_NOT_APPROVED");
  options = { ...options };
  options.signal?.throwIfAborted();
  const deadline = Date.now() + 120_000;
  const { config, fingerprint, pinned } = await load(options.configPath);
  options.signal?.throwIfAborted();
  await validateOcrTempRoot(config.tempRoot);
  const dir = await mkdtemp(join(config.tempRoot, "studio-ocr-"));
  try {
    const stack = join(dir, "stack");
    await mkdir(stack, { mode: 0o700 });
    for (const [name, data] of pinned)
      await writeFile(join(stack, name), data, { flag: "wx", mode: 0o700 });
    pinned.clear();
    await writeFile(
      join(dir, "fonts.conf"),
      '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig><dir prefix="cwd">stack</dir><cachedir prefix="cwd">font-cache</cachedir></fontconfig>',
      { flag: "wx", mode: 0o600 },
    );
    // Fail before passing private PDF bytes if required loader dependencies/engines cannot start.
    for (const name of ["pdftoppm", "pdfinfo", "tesseract"]) {
      const dependencies = await command(
        stack,
        dir,
        name,
        [],
        deadline,
        options.signal,
        true,
      );
      for (const line of dependencies.split("\n")) {
        if (line.includes("=>") && !line.includes(`=> ${stack}/`))
          throw new Error(
            "OCR_STACK_MISMATCH: dependency missing from pinned stack",
          );
      }
    }
    const renderVersion = await command(
      stack,
      dir,
      "pdftoppm",
      ["-v"],
      deadline,
      options.signal,
    );
    const ocrVersion = await command(
      stack,
      dir,
      "tesseract",
      ["--version"],
      deadline,
      options.signal,
    );
    if (
      !renderVersion.includes("pdftoppm version") ||
      !ocrVersion.includes("tesseract")
    )
      throw new Error("OCR_STACK_MISMATCH: engine version output");
    if (bytes.length > 20 * 1024 * 1024)
      throw new Error("OCR_BUDGET_EXCEEDED: PDF bytes");
    const pdf = join(dir, "input.pdf");
    await writeFile(pdf, bytes, { flag: "wx", mode: 0o600 });
    const info = await command(
      stack,
      dir,
      "pdfinfo",
      [pdf],
      deadline,
      options.signal,
    );
    const pageCount = Number(/^Pages:\s+(\d+)\s*$/m.exec(info)?.[1]);
    if (/^Encrypted:\s+yes/m.test(info))
      throw new Error("OCR_UNAVAILABLE: encrypted PDF");
    if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 20)
      throw new Error("OCR_BUDGET_EXCEEDED: require 1..20 PDF pages");
    const elements: CapturedElement[] = [],
      images: CapturedImage[] = [];
    let totalPng = 0;
    for (let page = 1; page <= pageCount; page++) {
      const pageDeadline = Math.min(deadline, Date.now() + 30_000);
      const geometry = await command(
        stack,
        dir,
        "pdfinfo",
        ["-f", String(page), "-l", String(page), "-box", pdf],
        pageDeadline,
        options.signal,
      );
      const size = /^Page\s+\d+ size:\s+([\d.]+) x ([\d.]+) pts/m.exec(
        geometry,
      );
      const longest = Math.max(Number(size?.[1]), Number(size?.[2]));
      if (!Number.isFinite(longest) || longest <= 0 || longest > 1_000_000)
        throw new Error("PDF_PAGE_UNRESOLVED: invalid page geometry");
      // scale-to overrides DPI in Poppler: never upscale a small page past 200 DPI.
      const scale = Math.min(2000, Math.floor((longest * 200) / 72));
      if (scale < 1) throw new Error("PDF_PAGE_UNRESOLVED: tiny page geometry");
      const out = join(dir, "page");
      await command(
        stack,
        dir,
        "pdftoppm",
        [
          "-f",
          String(page),
          "-l",
          String(page),
          "-singlefile",
          "-r",
          "200",
          "-scale-to",
          String(scale),
          "-png",
          pdf,
          out,
        ],
        pageDeadline,
        options.signal,
      );
      const png = await readRegularFileWithin(
        dir,
        out + ".png",
        8 * 1024 * 1024,
      );
      validatePng(png);
      totalPng += png.length;
      if (totalPng > 8 * 1024 * 1024)
        throw new Error("OCR_BUDGET_EXCEEDED: aggregate PNG bytes");
      // txt only: no undeclared/unretained TSV artifacts or external config-file lookup.
      await command(
        stack,
        dir,
        "tesseract",
        [
          out + ".png",
          out,
          "--tessdata-dir",
          stack,
          "-l",
          "eng+chi_sim",
          "--oem",
          "1",
          "--psm",
          "6",
        ],
        pageDeadline,
        options.signal,
      );
      const txt = await readRegularFileWithin(dir, out + ".txt", 400_000);
      const transcript = new TextDecoder("utf-8", { fatal: true }).decode(txt);
      if (!transcript.trim())
        throw new Error(
          `OCR_EMPTY_TRANSCRIPT: page ${page}; blank/recognition failure unresolved; no partial import`,
        );
      if (transcript.length > 100_000 || transcript.includes("\0"))
        throw new Error("OCR_BUDGET_EXCEEDED: transcript");
      const provenance: OcrPage = {
        kind: "ocr",
        verification: "unverified",
        sourceHash: sha256(bytes),
        page,
        pageCount,
        pageRenderHash: await blobs.put(png),
        transcriptHash: await blobs.put(txt),
        stackFingerprint: fingerprint,
        recipeFingerprint: sha256(OCR_RECIPE),
        width: png.readUInt32BE(16),
        height: png.readUInt32BE(20),
      };
      const elementIds: string[] = [];
      for (let start = 0; start < transcript.length; start += 30_000) {
        const id = `element_${elements.length}`;
        elementIds.push(id);
        const end = Math.min(start + 30_000, transcript.length);
        elements.push({
          id,
          text: transcript.slice(start, end),
          locator: { kind: "page", page },
          provenance: {
            ...provenance,
            transcriptStart: start,
            transcriptEnd: end,
          },
        });
      }
      images.push({
        id: `image_${images.length}`,
        blobHash: provenance.pageRenderHash,
        locator: { kind: "page", page },
        originKind: "page_render",
        caption: `Page ${page}. ${OCR_WARNING}`,
        elementIds,
        provenance,
      });
      await rm(out + ".png");
      await rm(out + ".txt");
    }
    options.signal?.throwIfAborted();
    if (Date.now() > deadline) throw new Error("OCR_TIMEOUT");
    return { elements, images, parserVersion: OCR_PARSER };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

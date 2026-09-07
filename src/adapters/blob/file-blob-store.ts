import { createHash, randomUUID } from "node:crypto";
import { link, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ensureDirectorySafe,
  readRegularFile,
  withSafeDirectory,
} from "../../core/path-safety.ts";
import type { BlobStore } from "../../ports/blob-store.ts";

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertHash(hash: string): void {
  if (!/^[a-f0-9]{64}$/.test(hash))
    throw new Error("Invalid SHA-256 identifier");
}

/** Single-user CAS. An exclusive hard link publishes complete bytes without overwrite. */
export class FileBlobStore implements BlobStore {
  readonly root: string;
  readonly maxBytes: number;

  constructor(root: string, maxBytes = 20 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      throw new Error("Invalid blob limit");
    this.root = root;
    this.maxBytes = maxBytes;
  }

  async put(input: Uint8Array): Promise<string> {
    if (input.byteLength > this.maxBytes)
      throw new Error("Blob exceeds size limit");
    const bytes = Buffer.from(input);
    const hash = sha256(bytes);
    await ensureDirectorySafe(this.root);
    await withSafeDirectory(this.root, this.root, async (directory) => {
      const info = await stat(directory);
      if (
        process.platform !== "win32" &&
        ((info.mode & 0o022) !== 0 || info.uid !== process.getuid?.())
      )
        throw new Error(
          "Blob root must be owned by the current user and not writable by group/others",
        );
      const temporary = join(directory, `.staging-${randomUUID()}`);
      const target = join(directory, hash);
      try {
        await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
        try {
          await link(temporary, target);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "EEXIST"
          )
            throw error;
        }
        const stored = await readRegularFile(target, this.maxBytes);
        if (sha256(stored) !== hash) throw new Error("Blob integrity mismatch");
      } finally {
        await rm(temporary, { force: true });
      }
    });
    return hash;
  }

  async get(hash: string): Promise<Uint8Array> {
    assertHash(hash);
    return withSafeDirectory(this.root, this.root, async (directory) => {
      const bytes = await readRegularFile(join(directory, hash), this.maxBytes);
      if (sha256(bytes) !== hash) throw new Error("Blob integrity mismatch");
      return bytes;
    });
  }
}

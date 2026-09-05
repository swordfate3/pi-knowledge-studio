import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

export async function realpathWithin(
  root: string,
  candidate: string,
): Promise<string> {
  if (candidate.includes("\0")) throw new Error("Path contains NUL.");
  const realRoot = await realpath(root);
  const realCandidate = await realpath(candidate);
  if (!isWithin(realRoot, realCandidate))
    throw new Error(`Path escapes source root: ${candidate}`);
  return realCandidate;
}

export async function assertNoSymlinkPath(
  root: string,
  candidate: string,
): Promise<void> {
  if (root.includes("\0") || candidate.includes("\0"))
    throw new Error("Path contains NUL.");
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  if (!isWithin(absoluteRoot, absoluteCandidate))
    throw new Error(`Path escapes source root: ${candidate}`);
  const rootInfo = await lstat(absoluteRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error(`Unsafe source root: ${root}`);

  const relativePath = relative(absoluteRoot, absoluteCandidate);
  let current = absoluteRoot;
  const segments = relativePath ? relativePath.split(sep) : [];
  for (const segment of segments) {
    current = resolve(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink())
      throw new Error(`Symlink path is not allowed: ${current}`);
  }
}

const DIRECTORY_FLAGS =
  constants.O_RDONLY |
  (constants.O_DIRECTORY ?? 0) |
  (constants.O_NOFOLLOW ?? 0);

type DirectoryHandle = import("node:fs/promises").FileHandle;

function descriptorPath(handle: DirectoryHandle): string | undefined {
  return process.platform === "linux"
    ? `/proc/self/fd/${handle.fd}`
    : undefined;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

async function openDirectoryChild(
  parent: DirectoryHandle,
  segment: string,
  create: boolean,
): Promise<DirectoryHandle> {
  const parentPath = descriptorPath(parent);
  if (!parentPath)
    throw new Error("Descriptor-relative directories are unavailable.");
  const childPath = join(parentPath, segment);
  try {
    return await open(childPath, DIRECTORY_FLAGS);
  } catch (error) {
    if (!create || errorCode(error) !== "ENOENT") throw error;
    try {
      await mkdir(childPath, { mode: 0o700 });
    } catch (mkdirError) {
      if (errorCode(mkdirError) !== "EEXIST") throw mkdirError;
    }
    return open(childPath, DIRECTORY_FLAGS);
  }
}

/**
 * Opens every absolute path component and keeps the descriptors open while the
 * callback operates. Descriptor-relative paths prevent an ancestor directory
 * from being swapped after it has been checked.
 */
export async function withSafeDirectory<T>(
  root: string,
  directory: string,
  operation: (stablePath: string) => Promise<T>,
): Promise<T> {
  const absoluteRoot = resolve(root);
  const absoluteDirectory = resolve(directory);
  if (!isWithin(absoluteRoot, absoluteDirectory))
    throw new Error(`Path escapes source root: ${directory}`);

  if (process.platform !== "linux") {
    await assertNoSymlinkPath(absoluteRoot, absoluteDirectory);
    return operation(absoluteDirectory);
  }

  const handles: DirectoryHandle[] = [];
  try {
    let handle = await open(sep, DIRECTORY_FLAGS);
    handles.push(handle);
    for (const segment of absoluteRoot.split(sep).filter(Boolean)) {
      handle = await openDirectoryChild(handle, segment, false);
      handles.push(handle);
    }
    if (!(await handle.stat()).isDirectory())
      throw new Error(`Unsafe directory: ${absoluteRoot}`);

    for (const segment of relative(absoluteRoot, absoluteDirectory)
      .split(sep)
      .filter(Boolean)) {
      handle = await openDirectoryChild(handle, segment, false);
      handles.push(handle);
      if (!(await handle.stat()).isDirectory())
        throw new Error(`Unsafe directory: ${absoluteDirectory}`);
    }

    return await operation(descriptorPath(handle) ?? absoluteDirectory);
  } finally {
    await Promise.all(
      handles.reverse().map((entry) => entry.close().catch(() => undefined)),
    );
  }
}

export async function readRegularFile(
  path: string,
  maxBytes: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new Error("File size limit is not configured correctly.");
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`Unsafe regular file: ${path}`);
    if (!Number.isSafeInteger(info.size) || info.size > maxBytes)
      throw new Error(`File exceeds size limit: ${path}`);
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (result.bytesRead === 0)
        throw new Error(`File could not be read completely: ${path}`);
      offset += result.bytesRead;
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function readRegularFileWithin(
  root: string,
  path: string,
  maxBytes: number,
): Promise<Buffer> {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(path);
  if (!isWithin(absoluteRoot, absolutePath))
    throw new Error(`Path escapes source root: ${path}`);
  return withSafeDirectory(
    absoluteRoot,
    dirname(absolutePath),
    (stableDirectory) =>
      readRegularFile(join(stableDirectory, basename(absolutePath)), maxBytes),
  );
}

export function safeRelativeResource(
  sourceDirectory: string,
  target: string,
): string | undefined {
  if (!target || target.includes("\0") || isAbsolute(target)) return undefined;
  const trimmed = target.trim();
  if (
    !trimmed ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    /^[a-z][a-z\d+.-]*:/i.test(trimmed) ||
    trimmed.startsWith("//")
  )
    return undefined;
  const segments = trimmed.split(/[\\/]+/);
  if (segments.some((segment) => segment === "..")) return undefined;
  const candidate = resolve(sourceDirectory, trimmed);
  return isWithin(resolve(sourceDirectory), candidate) ? candidate : undefined;
}

export async function ensureDirectorySafe(path: string): Promise<void> {
  if (path.includes("\0")) throw new Error("Path contains NUL.");
  const absolute = resolve(path);
  if (process.platform === "linux") {
    const handles: DirectoryHandle[] = [];
    try {
      let handle = await open(sep, DIRECTORY_FLAGS);
      handles.push(handle);
      for (const segment of absolute.split(sep).filter(Boolean)) {
        handle = await openDirectoryChild(handle, segment, true);
        handles.push(handle);
      }
      if (!(await handle.stat()).isDirectory())
        throw new Error(`Unsafe directory: ${path}`);
    } finally {
      await Promise.all(
        handles.reverse().map((entry) => entry.close().catch(() => undefined)),
      );
    }
    return;
  }

  const parts = absolute.split(sep);
  let current = parts[0] === "" ? sep : parts[0];
  for (const part of parts.slice(1)) {
    if (!part) continue;
    current = current === sep ? `${current}${part}` : `${current}${sep}${part}`;
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error(`Unsafe directory: ${path}`);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (errorCode(mkdirError) !== "EEXIST") throw mkdirError;
      }
      const created = await lstat(current);
      if (!created.isDirectory() || created.isSymbolicLink())
        throw new Error(`Unsafe directory: ${path}`);
    }
  }
}

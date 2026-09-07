import { inflateSync } from "node:zlib";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Deliberately narrow first display format: CRC-checked, 8-bit, non-interlaced PNG. */
export function validatePng(input: Uint8Array): void {
  const bytes = Buffer.from(input);
  if (
    bytes.length > 20 * 1024 * 1024 ||
    !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  )
    throw new Error("Unsupported image: expected PNG");
  let offset = 8;
  let expected = 0;
  let rowBytes = 0;
  let ended = false;
  let dataClosed = false;
  const data: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error("Truncated PNG");
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    if (
      ![...typeBytes].every(
        (byte) => (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122),
      ) ||
      typeBytes[2]! < 65 ||
      typeBytes[2]! > 90
    )
      throw new Error("Invalid PNG chunk name");
    const type = typeBytes.toString("ascii");
    if (
      crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)
    )
      throw new Error("PNG CRC mismatch");
    const payload = bytes.subarray(offset + 8, end - 4);
    if (offset === 8) {
      if (type !== "IHDR" || length !== 13)
        throw new Error("Invalid PNG header");
      const width = payload.readUInt32BE(0);
      const height = payload.readUInt32BE(4);
      const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[
        payload[9]!
      ];
      if (
        !width ||
        !height ||
        width * height > 4_000_000 ||
        payload[8] !== 8 ||
        !channels ||
        payload[10] !== 0 ||
        payload[11] !== 0 ||
        payload[12] !== 0
      )
        throw new Error("Unsupported PNG layout or pixel budget");
      rowBytes = width * channels + 1;
      expected = rowBytes * height;
    } else if (type === "IDAT") {
      if (dataClosed) throw new Error("Nonconsecutive PNG image data");
      data.push(payload);
    } else if (type === "IEND") {
      if (length !== 0 || end !== bytes.length || !data.length)
        throw new Error("Invalid PNG ending");
      ended = true;
    } else {
      if (data.length) dataClosed = true;
      // Unknown critical chunks, duplicate headers, palette and animation are not supported yet.
      if (
        !/^[a-z][A-Za-z]{3}$/.test(type) ||
        ["acTL", "fcTL", "fdAT"].includes(type)
      )
        throw new Error("Unsupported PNG chunk");
    }
    offset = end;
  }
  if (!ended) throw new Error("Incomplete PNG");
  const compressed = Buffer.concat(data);
  // Node returns { buffer, engine } with info:true; older Node type declarations only expose Buffer.
  const result: unknown = inflateSync(compressed, {
    maxOutputLength: expected + 1,
    info: true,
  });
  if (
    !result ||
    typeof result !== "object" ||
    !("buffer" in result) ||
    !Buffer.isBuffer(result.buffer) ||
    !("engine" in result) ||
    !result.engine ||
    typeof result.engine !== "object" ||
    !("bytesWritten" in result.engine)
  )
    throw new Error("Unsupported inflater result");
  if (result.engine.bytesWritten !== compressed.length)
    throw new Error("Trailing PNG compressed content");
  const decoded = result.buffer;
  if (decoded.length !== expected) throw new Error("PNG pixel length mismatch");
  for (let start = 0; start < decoded.length; start += rowBytes) {
    if (decoded[start]! > 4) throw new Error("Invalid PNG filter");
  }
}

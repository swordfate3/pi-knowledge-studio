import { deflateSync } from "node:zlib";
import { validatePng } from "./png.ts";

/** Encodes decoded pixels; callers must label the result as derived, not original bytes. */
export function encodePng(
  width: number,
  height: number,
  channels: number,
  pixels: Uint8Array,
): Buffer {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 4_000_000 ||
    ![1, 3, 4].includes(channels) ||
    pixels.length !== width * height * channels
  )
    throw new Error("Unsupported decoded image");
  function chunk(type: string, bytes: Buffer): Buffer {
    const output = Buffer.alloc(bytes.length + 12);
    output.writeUInt32BE(bytes.length);
    output.write(type, 4, "ascii");
    bytes.copy(output, 8);
    let crc = 0xffffffff;
    for (const byte of output.subarray(4, output.length - 4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
    return output;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  const rows = Buffer.alloc(height * (width * channels + 1));
  for (let row = 0; row < height; row++)
    rows.set(
      pixels.subarray(row * width * channels, (row + 1) * width * channels),
      row * (width * channels + 1) + 1,
    );
  const result = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  validatePng(result);
  return result;
}

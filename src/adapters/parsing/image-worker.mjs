// Local maintained native decoder, not a sandbox. Parent enforces wall/output bounds.
import process from 'node:process';
try {
  const { default: sharp } = await import('sharp').catch(() => { throw new Error('Optional decoder unavailable: install project optional dependency sharp (including native platform packages)'); });
  sharp.cache(false); sharp.concurrency(1);
  let size = 0; const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 20 * 1024 * 1024) throw new Error('Image input budget exceeded');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const image = sharp(bytes, { failOn: 'warning', limitInputPixels: 4_000_000, sequentialRead: true });
  const metadata = await image.metadata();
  if (!['jpeg', 'webp'].includes(metadata.format) || (metadata.pages ?? 1) !== 1 ||
      !metadata.width || !metadata.height || metadata.width * metadata.height > 4_000_000)
    throw new Error('Unsupported image format, animation or dimensions');
  // No autorotation: stored pixel coordinates, ignore EXIF orientation; convert to sRGB.
  const { data, info } = await image.toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const header = JSON.stringify({ mediaType: `image/${metadata.format}`, width: info.width, height: info.height,
    recipe: `sharp-${sharp.versions.sharp}-vips-${sharp.versions.vips}:srgb-rgba-unoriented-v1` });
  process.stdout.write(header + '\n'); process.stdout.write(data);
} catch (error) { process.stderr.write(String(error.message).slice(0, 2000)); process.exitCode = 1; }

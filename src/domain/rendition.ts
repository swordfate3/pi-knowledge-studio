export interface ImageRendition {
  mediaType: "image/png";
  blobHash: string;
  sourceMediaType: "image/jpeg" | "image/webp";
  recipe: string;
  width: number;
  height: number;
}

export function validateRendition(value: unknown): asserts value is ImageRendition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid image rendition");
  const r = value as ImageRendition;
  const fields = ["mediaType", "blobHash", "sourceMediaType", "recipe", "width", "height"];
  if (Object.keys(r).length !== fields.length || fields.some(k => !Object.hasOwn(r, k)) ||
      r.mediaType !== "image/png" || !["image/jpeg", "image/webp"].includes(r.sourceMediaType) ||
      typeof r.blobHash !== "string" || !/^[a-f0-9]{64}$/.test(r.blobHash) ||
      typeof r.recipe !== "string" || !/^sharp-[0-9.]+-vips-[0-9.]+:srgb-rgba-unoriented-v1$/.test(r.recipe) ||
      !Number.isSafeInteger(r.width) || !Number.isSafeInteger(r.height) || r.width < 1 || r.height < 1 || r.width*r.height > 4_000_000)
    throw new Error("Invalid image rendition");
}

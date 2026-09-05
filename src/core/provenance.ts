import { createHash } from "node:crypto";

export function stableId(...parts: string[]): string {
  return createHash("sha256")
    .update(parts.join("\u001f"))
    .digest("hex")
    .slice(0, 24);
}

export function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function citationLabel(locator: {
  sourceUri: string;
  page?: number;
  lineStart?: number;
  lineEnd?: number;
}): string {
  const page = locator.page === undefined ? "" : `, p. ${locator.page}`;
  const lines =
    locator.lineStart === undefined
      ? ""
      : `, lines ${locator.lineStart}-${locator.lineEnd ?? locator.lineStart}`;
  return `${locator.sourceUri}${page}${lines}`;
}

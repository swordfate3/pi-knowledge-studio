// @ts-ignore TS2691: Pi loads the TypeScript extension source through its Jiti loader.
import { citationLabel } from "../core/provenance.ts";
// @ts-ignore TS2691: Pi loads the TypeScript extension source through its Jiti loader.
import type { AssetRecord, Profile, SearchHit } from "../core/types.ts";

function escapeMarkdown(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/[\\`*_[\]{}<>]/g, "\\$&");
}

function evidenceBlock(value: string): string[] {
  const text = value.replace(/\r\n?/g, "\n").trim();
  const longestFence = Math.max(
    0,
    ...Array.from(text.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestFence + 1));
  return [`${fence}text`, text, fence];
}

function safeAssetPath(value: string): boolean {
  if (!value || /[\r\n\u0000<>%]/u.test(value)) return false;
  if (value.startsWith("/") || value.startsWith("\\")) return false;
  if (/^[a-z][a-z\d+.-]*:/iu.test(value)) return false;
  if (/^[a-z]:/iu.test(value)) return false;
  return value
    .split(/[\\/]/u)
    .every((part) => part !== "" && part !== "." && part !== "..");
}

export interface DocumentDraft {
  title: string;
  topic: string;
  profile: Profile;
  hits: SearchHit[];
  assets: AssetRecord[];
  notes?: string;
}

export function renderMarkdown(draft: DocumentDraft): string {
  const lines: string[] = [
    `# ${escapeMarkdown(draft.title)}`,
    "",
    `> Topic: ${escapeMarkdown(draft.topic)}`,
    `> Profile: ${escapeMarkdown(draft.profile.name)}`,
    "",
    "## Evidence",
    "",
  ];
  if (draft.notes?.trim()) lines.push(...evidenceBlock(draft.notes), "");
  if (draft.hits.length === 0)
    lines.push("No matching evidence was found.", "");
  for (const [index, hit] of draft.hits.entries()) {
    lines.push(
      `### ${index + 1}. ${escapeMarkdown(hit.kind === "asset" ? (hit.title ?? "Asset") : "Source excerpt")}`,
      "",
      ...evidenceBlock(hit.text),
      "",
      `*Source: ${escapeMarkdown(citationLabel(hit.locator))}*`,
      "",
    );
  }
  if (draft.assets.length > 0) {
    lines.push("## Original assets", "");
    for (const asset of draft.assets) {
      const label =
        asset.title ??
        asset.caption ??
        `${asset.kind} on page ${asset.locator.page ?? "?"}`;
      lines.push(`### ${escapeMarkdown(label)}`, "");
      if (safeAssetPath(asset.storedPath)) {
        lines.push(`![${escapeMarkdown(label)}](<${asset.storedPath}>)`, "");
      } else {
        lines.push("[Asset omitted: unsafe stored path]", "");
      }
      lines.push(
        `*Source: ${escapeMarkdown(citationLabel(asset.locator))}*`,
        "",
      );
    }
  }
  lines.push(
    "## Notes on interpretation",
    "",
    ...evidenceBlock(draft.profile.explanationGuidance),
    "",
  );
  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

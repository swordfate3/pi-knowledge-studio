import { sha256 } from "../adapters/blob/file-blob-store.ts";
import type { CapturedDocument, SearchHit } from "../domain/retrieval.ts";
import type {
  VisionHint,
  VisionHintInput,
} from "../domain/vision-enrichment.ts";
import { tokenize } from "./rank-evidence.ts";
import { validateCapture } from "./validate-capture.ts";

/** Output is deliberately excluded: a second output for this derivation is a conflict. */
function hintId(input: VisionHintInput): string {
  return `hint_${sha256(
    JSON.stringify([
      "vision-hint-v1",
      input.documentId,
      input.revision,
      input.sourceHash,
      input.imageId,
      input.blobHash,
      input.modelFingerprint,
      input.promptFingerprint,
    ]),
  )}`;
}

export function validateVisionHint(
  record: unknown,
  document: CapturedDocument,
): asserts record is VisionHint {
  validateCapture(document);
  if (!record || typeof record !== "object" || Array.isArray(record))
    throw new Error("Invalid vision hint");
  const hint = record as VisionHint;
  const fields = [
    "id",
    "documentId",
    "revision",
    "sourceHash",
    "imageId",
    "blobHash",
    "modelFingerprint",
    "promptFingerprint",
    "description",
    "descriptionHash",
    "authority",
  ];
  if (
    Object.keys(hint).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(hint, key))
  )
    throw new Error("Invalid vision hint fields");
  if (
    typeof hint.id !== "string" ||
    !/^hint_[a-f0-9]{64}$/.test(hint.id) ||
    typeof hint.documentId !== "string" ||
    !/^doc_[a-f0-9]{64}$/.test(hint.documentId) ||
    typeof hint.imageId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(hint.imageId) ||
    [
      hint.revision,
      hint.sourceHash,
      hint.blobHash,
      hint.modelFingerprint,
      hint.promptFingerprint,
      hint.descriptionHash,
    ].some(
      (value) => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value),
    ) ||
    hint.authority !== "retrieval-only" ||
    typeof hint.description !== "string" ||
    hint.description.length > 16_000 ||
    !hint.description.trim()
  )
    throw new Error("Invalid vision hint fields");
  const image = document.images.find((item) => item.id === hint.imageId);
  if (
    hint.documentId !== document.id ||
    hint.revision !== document.revision ||
    hint.sourceHash !== document.sourceHash ||
    !image ||
    hint.blobHash !== image.blobHash
  )
    throw new Error("Vision hint binding mismatch");
  if (
    hint.descriptionHash !== sha256(hint.description) ||
    hint.id !== hintId(hint)
  )
    throw new Error("Vision hint integrity mismatch");
}

/** Pure host-side derivation. No output-supplied references or changes to the capture. */
export function createVisionHint(
  document: CapturedDocument,
  input: VisionHintInput,
): VisionHint {
  const hint: VisionHint = {
    ...input,
    id: hintId(input),
    descriptionHash: sha256(input.description),
    authority: "retrieval-only",
  };
  validateVisionHint(hint, document);
  return Object.freeze(hint);
}

/** Description tokens affect discovery only; hits retain the original document/element. */
export function lexicalHintHits(
  query: string,
  docs: CapturedDocument[],
  hints: readonly VisionHint[],
): SearchHit[] {
  const terms = new Set(tokenize(query));
  const hits = new Map<string, SearchHit>();
  const seen = new Map<string, string>();
  for (const hint of hints) {
    const document = docs.find(
      (doc) => doc.id === hint.documentId && doc.revision === hint.revision,
    );
    if (!document) continue;
    validateVisionHint(hint, document);
    const old = seen.get(hint.id);
    if (old !== undefined && old !== hint.description)
      throw new Error("Immutable vision hint conflict");
    seen.set(hint.id, hint.description);
    const tokens = new Set(tokenize(hint.description));
    const score = [...terms].filter((term) => tokens.has(term)).length;
    if (!score) continue;
    const image = document.images.find((item) => item.id === hint.imageId)!;
    for (const element of document.elements) {
      if (!image.elementIds.includes(element.id)) continue;
      const key = JSON.stringify([document.id, document.revision, element.id]);
      if (score > (hits.get(key)?.score ?? 0))
        hits.set(key, { document, element, score });
    }
  }
  return [...hits.values()].sort(
    (a, b) =>
      b.score - a.score ||
      a.document.id.localeCompare(b.document.id) ||
      a.element.id.localeCompare(b.element.id),
  );
}

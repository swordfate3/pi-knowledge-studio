import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import type { EvidenceBundle } from "../domain/evidence.ts";
import type { CapturedDocument } from "../domain/retrieval.ts";
import type { AnswerResult, HostFigureCandidate } from "../domain/answer.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Trusted catalog + retrieved bundle only. Adjacency is not visual verification. */
export function buildAnswerContext(bundle: EvidenceBundle, snapshot: { epoch: number; documents: CapturedDocument[] }): HostFigureCandidate[] {
  if (bundle.snapshotId !== `epoch_${snapshot.epoch}`)
    throw new Error("Sources changed during generation; retry explicitly");
  const documents = new Map(snapshot.documents.map(document => [document.id, document]));
  for (const source of bundle.sources) {
    if (documents.get(source.id)?.revision !== source.revisionHash)
      throw new Error("Answer source revision mismatch");
  }
  for (const text of bundle.texts) {
    const document = documents.get(text.sourceId);
    const element = document?.elements.find(element => element.id === text.elementId);
    if (!bundle.sources.some(source => source.id === text.sourceId) || !element ||
        text.id !== `text_${hash(text.sourceId + element.id)}` ||
        !isDeepStrictEqual(text.locator, element.locator) ||
        !isDeepStrictEqual(text.provenance, element.provenance) ||
        !Number.isInteger(text.start) || !Number.isInteger(text.end) || text.start < 0 || text.end > element.text.length || text.end <= text.start ||
        text.text !== element.text.slice(text.start, text.end) || text.textHash !== hash(text.text))
      throw new Error("Answer text does not match captured source");
  }
  return bundle.images.flatMap(occurrence => {
    const document = documents.get(occurrence.sourceId);
    const image = document?.images.find(image => occurrence.id === `figure_${hash(occurrence.sourceId + image.id)}`);
    if (!bundle.sources.some(source => source.id === occurrence.sourceId) || !image ||
        occurrence.blobHash !== image.blobHash || occurrence.originKind !== image.originKind ||
        !isDeepStrictEqual(occurrence.locator, image.locator) ||
        !isDeepStrictEqual(occurrence.provenance, image.provenance) ||
        !isDeepStrictEqual(occurrence.rendition, image.rendition))
      throw new Error("Answer figure does not match captured occurrence");
    const linkedTextIds = bundle.texts.filter(text => text.sourceId === occurrence.sourceId && image.elementIds.includes(text.elementId)).map(text => text.id);
    return linkedTextIds.length ? [{ occurrenceId: occurrence.id, linkedTextIds, caption: image.caption }] : [];
  });
}

export const INSUFFICIENT_ANSWER_NOTICE = "The retrieved evidence is insufficient to answer this question. This assessment is limited to retrieved evidence, not a claim that the entire collection lacks an answer. No document was generated or exported.";

/** Runtime's documented empty retrieval has no bundle: do not invent one. */
export function emptyAnswer(question: string): Omit<Extract<AnswerResult, { status: "insufficient-evidence" }>, "assessment"> & { assessment: Omit<AnswerResult["assessment"], "bundleId"> & { bundleId: null } } {
  return { status: "insufficient-evidence", document: null, reasons: ["no-candidates"], assessment: { question, bundleId: null, provenance: "deterministic", semanticProof: false, requirements: [], figures: [] } };
}

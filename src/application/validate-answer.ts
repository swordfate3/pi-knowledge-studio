import { ANSWER_WIRE_VERSION } from "../domain/answer.ts";
import type { EvidenceBundle, IllustratedDocument } from "../domain/evidence.ts";
import type { AnswerResult, AnswerWireResponse, FigurePolicy, HostFigureCandidate, InsufficiencyReason } from "../domain/answer.ts";
import { validateEvidence } from "./validate-evidence.ts";

/** Counts only: never includes requirement/evidence IDs or generated content. */
export interface AnswerCoverageDiagnostics {
  /** Retained telemetry key: counts an empty paragraphs array in wire v2. */
  emptyBlocks: number;
  uncoveredRequirements: number;
  undisplayedFigures: number;
  missingEvidenceMappings: number;
}
export class AnswerCoverageError extends Error {
  readonly category = "incomplete-answer-mappings";
  readonly counts: Readonly<AnswerCoverageDiagnostics>;
  constructor(counts: AnswerCoverageDiagnostics) {
    super("Incomplete answer mappings");
    this.name = "AnswerCoverageError";
    this.counts = Object.freeze({ ...counts });
  }
}

export function answerObject(value: unknown, expected?: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid answer object");
  const result = value as Record<string, unknown>;
  if (expected && (Object.keys(result).length !== expected.length || expected.some(key => !Object.hasOwn(result, key))))
    throw new Error("Unexpected or missing answer fields");
  return result;
}
export function answerText(value: unknown, max = 16_384): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid or oversized answer text");
}
export function answerArray(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("Answer array budget exceeded");
  return value;
}
function refs(value: unknown, allowed: Set<string>, nonempty = true): string[] {
  const values = answerArray(value, 100);
  if ((nonempty && !values.length) || new Set(values).size !== values.length) throw new Error("Missing or duplicate answer references");
  for (const id of values) {
    answerText(id, 128);
    if (!allowed.has(id)) throw new Error("Unknown answer reference");
  }
  return values as string[];
}
export function freezeAnswerTree(value: unknown): void {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeAnswerTree(child);
    Object.freeze(value);
  }
}

/** Validate disclosure shape before egress; no fields silently removed (including OCR assets). */
export function validateAnswerInput(bundle: EvidenceBundle, question: string, title: string, policy: FigurePolicy, candidates: HostFigureCandidate[]): void {
  answerText(question, 8192);
  answerText(title, 1024);
  if (!["none", "selective", "required"].includes(policy)) throw new Error("Invalid figure policy");
  answerObject(bundle, ["schemaVersion", "id", "snapshotId", "sources", "texts", "images"]);
  for (const source of answerArray(bundle.sources, 100)) answerObject(source, ["id", "label", "revisionHash"]);
  for (const text of answerArray(bundle.texts, 100)) {
    const item = answerObject(text);
    answerObject(item, ["id", "sourceId", "elementId", "locator", "text", "textHash", "start", "end", ...(Object.hasOwn(item, "provenance") ? ["provenance"] : [])]);
    if (Object.hasOwn(item, "provenance") && !item.provenance) throw new Error("Invalid OCR provenance");
  }
  for (const image of answerArray(bundle.images, 100)) {
    const item = answerObject(image);
    answerObject(item, ["id", "sourceId", "locator", "blobHash", "originKind", ...(Object.hasOwn(item, "provenance") ? ["provenance"] : []), ...(Object.hasOwn(item, "rendition") ? ["rendition"] : [])]);
    if (Object.hasOwn(item, "provenance") && !item.provenance) throw new Error("Invalid OCR provenance");
    if (Object.hasOwn(item, "rendition") && !item.rendition) throw new Error("Invalid rendition");
  }
  for (const item of [...bundle.texts, ...bundle.images]) {
    const locator = answerObject(item.locator);
    answerObject(locator, locator.kind === "page" ? ["kind", "page"] : locator.kind === "lines" ? ["kind", "start", "end"] : ["kind", "anchor"]);
  }
  validateEvidence(bundle, { title, bundleId: bundle.id, mode: "model-generated", blocks: [] });
  const seen = new Set<string>();
  for (const value of answerArray(candidates, 100)) {
    const candidate = answerObject(value, ["occurrenceId", "linkedTextIds", "caption"]);
    answerText(candidate.occurrenceId, 128);
    // Empty source captions are legitimate; never replace them with imagined descriptions.
    if (typeof candidate.caption !== "string" || candidate.caption.length > 4096) throw new Error("Invalid figure caption");
    const image = bundle.images.find(image => image.id === candidate.occurrenceId);
    if (!image || seen.has(image.id)) throw new Error("Unknown or duplicate host figure occurrence");
    seen.add(image.id);
    refs(candidate.linkedTextIds, new Set(bundle.texts.filter(text => text.sourceId === image.sourceId).map(text => text.id)));
  }
  if (Buffer.byteLength(JSON.stringify({ bundle, question, title, figurePolicy: policy, hostDerivedFigureCandidates: candidates })) > 512 * 1024)
    throw new Error("Answer input payload budget exceeded");
}

/** Structural consistency only. A model can still omit requirements or misjudge support.
 * Call with the validated, immutable input snapshot used for the approved request.
 */
export function validateAnswer(value: unknown, bundle: EvidenceBundle, question: string, title: string, policy: FigurePolicy, candidates: HostFigureCandidate[]): AnswerResult {
  validateAnswerInput(bundle, question, title, policy, candidates);
  const raw = answerObject(value, ["wireVersion", "status", "requirements", "figures", "paragraphs"]);
  if (raw.wireVersion !== ANSWER_WIRE_VERSION) throw new Error("Unsupported answer wire version");
  if (raw.status !== "answered" && raw.status !== "insufficient-evidence") throw new Error("Invalid answer status");
  const textIds = new Set(bundle.texts.map(text => text.id));
  const requirementIds = new Set<string>();
  for (const value of answerArray(raw.requirements, 100)) {
    const requirement = answerObject(value, ["id", "requirement", "status", "evidenceIds"]);
    answerText(requirement.id, 128);
    if (!/^[A-Za-z0-9_-]+$/.test(requirement.id) || requirementIds.has(requirement.id)) throw new Error("Invalid or duplicate requirement ID");
    requirementIds.add(requirement.id);
    answerText(requirement.requirement, 4096);
    if (typeof requirement.status !== "string" || !["supported", "missing", "conflicting", "unassessed"].includes(requirement.status)) throw new Error("Invalid requirement status");
    const ids = refs(requirement.evidenceIds, textIds, requirement.status === "supported" || requirement.status === "conflicting");
    if (requirement.status === "conflicting" && ids.length < 2) throw new Error("Conflict needs distinct evidence mappings");
  }
  if (!requirementIds.size) throw new Error("Missing requirement assessment");
  // SAFETY: requirement fields have been checked; other fields are checked below before use.
  const requirements = (raw as unknown as AnswerWireResponse).requirements;
  const selected = new Set<string>();
  for (const value of answerArray(raw.figures, 100)) {
    const figure = answerObject(value, ["occurrenceId", "requirementId", "evidenceIds", "justification"]);
    answerText(figure.occurrenceId, 128);
    answerText(figure.requirementId, 128);
    answerText(figure.justification, 4096);
    const host = candidates.find(candidate => candidate.occurrenceId === figure.occurrenceId);
    const requirement = requirements.find(item => item.id === figure.requirementId);
    if (policy === "none" || !host || selected.has(host.occurrenceId) || requirement?.status !== "supported") throw new Error("Invalid figure selection");
    const allowed = new Set(host.linkedTextIds.filter(id => requirement.evidenceIds.includes(id)));
    refs(figure.evidenceIds, allowed);
    selected.add(host.occurrenceId);
  }
  const paragraphs = answerArray(raw.paragraphs, 200);
  if (paragraphs.length + selected.size > 200) throw new Error("Answer array budget exceeded");
  const result = raw as unknown as AnswerWireResponse;
  const reasons: InsufficiencyReason[] = [];
  if (!bundle.texts.length) reasons.push("no-candidates");
  if (requirements.some(item => item.status === "missing")) reasons.push("missing-support");
  if (requirements.some(item => item.status === "conflicting")) reasons.push("conflicting-evidence");
  if (requirements.some(item => item.status === "unassessed")) reasons.push("unassessed");
  if (policy === "required" && !selected.size) reasons.push("required-figure-missing");
  const assessment = { question, bundleId: bundle.id, provenance: "model-judgment" as const, semanticProof: false as const, requirements, figures: result.figures };
  if (raw.status === "insufficient-evidence") {
    if (paragraphs.length || selected.size) throw new Error("Abstention cannot contain answer paragraphs or selected figures");
    if (!reasons.length) throw new Error("Abstention needs an insufficiency assessment");
    return { status: "insufficient-evidence", assessment, reasons, document: null };
  }
  if (reasons.length) throw new Error("Answered response has insufficient evidence");
  const covered = new Set<string>();
  const usedEvidence = new Map<string, Set<string>>();
  const record = (requirementId: string, ids: string[]) => {
    covered.add(requirementId);
    const used = usedEvidence.get(requirementId) ?? new Set<string>();
    for (const id of ids) used.add(id);
    usedEvidence.set(requirementId, used);
  };
  for (const value of paragraphs) {
    const paragraph = answerObject(value, ["text", "evidenceIds", "requirementIds"]);
    answerText(paragraph.text);
    const ids = refs(paragraph.evidenceIds, textIds);
    const mapped = refs(paragraph.requirementIds, requirementIds);
    const mappedRequirements = requirements.filter(item => mapped.includes(item.id));
    if (ids.some(id => !mappedRequirements.some(item => item.evidenceIds.includes(id))) || mappedRequirements.some(item => !item.evidenceIds.some(id => ids.includes(id)))) throw new Error("False paragraph requirement mapping");
    for (const requirement of mappedRequirements) record(requirement.id, ids.filter(id => requirement.evidenceIds.includes(id)));
  }
  const coverage: AnswerCoverageDiagnostics = {
    emptyBlocks: paragraphs.length ? 0 : 1,
    uncoveredRequirements: requirements.length - covered.size,
    undisplayedFigures: 0, // Host assembly displays every validated selection exactly once.
    missingEvidenceMappings: requirements.reduce((count, item) => count + item.evidenceIds.filter(id => !usedEvidence.get(item.id)?.has(id)).length, 0),
  };
  if (Object.values(coverage).some(count => count > 0)) throw new AnswerCoverageError(coverage);
  // Do not assemble even a partial document until all paragraph coverage passes.
  const document: IllustratedDocument = { title, bundleId: bundle.id, mode: "model-generated", blocks: [] };
  for (const paragraph of result.paragraphs)
    document.blocks.push({ kind: "paragraph", text: paragraph.text, evidenceIds: [...paragraph.evidenceIds] });
  for (const selection of result.figures) {
    const host = candidates.find(item => item.occurrenceId === selection.occurrenceId)!;
    document.blocks.push({ kind: "figure", occurrenceId: host.occurrenceId, caption: host.caption, evidenceIds: [...selection.evidenceIds] });
  }
  validateEvidence(bundle, document);
  return { status: "answered", assessment, reasons: [], document };
}

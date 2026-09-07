import type { IllustratedDocument } from "./evidence.ts";

export type FigurePolicy = "none" | "selective" | "required";
/** Trusted host output from captured source links, never model-supplied mappings.
 * Occurrence identity binds source/revision/locator via the approved bundle.
 * Captions/linkage do not establish pixel content or semantic sufficiency.
 */
export interface HostFigureCandidate {
  occurrenceId: string;
  linkedTextIds: string[];
  caption: string;
}
export interface RequirementAssessment {
  id: string;
  requirement: string;
  status: "supported" | "missing" | "conflicting" | "unassessed";
  evidenceIds: string[];
}
export interface FigureSelection {
  occurrenceId: string;
  requirementId: string;
  evidenceIds: string[];
  /** Model judgment of illustration need, not a visual claim. */
  justification: string;
}
export type InsufficiencyReason = "no-candidates" | "missing-support" | "conflicting-evidence" | "unassessed" | "required-figure-missing";
export interface AnswerAssessment {
  question: string;
  bundleId: string;
  provenance: "model-judgment" | "deterministic";
  /** Host-owned disclaimer; structure/reference checks are not entailment checks. */
  semanticProof: false;
  requirements: RequirementAssessment[];
  figures: FigureSelection[];
}
export type AnswerResult =
  | { status: "answered"; assessment: AnswerAssessment; reasons: []; document: IllustratedDocument }
  | { status: "insufficient-evidence"; assessment: AnswerAssessment; reasons: InsufficiencyReason[]; document: null };

/** Versioned internal protocol; the host alone constructs public document blocks. */
export const ANSWER_WIRE_VERSION = "grounded-answer-v2" as const;
export interface AnswerWireParagraph {
  text: string;
  evidenceIds: string[];
  requirementIds: string[];
}
export interface AnswerWireResponse {
  wireVersion: typeof ANSWER_WIRE_VERSION;
  status: "answered" | "insufficient-evidence";
  requirements: RequirementAssessment[];
  figures: FigureSelection[];
  paragraphs: AnswerWireParagraph[];
}

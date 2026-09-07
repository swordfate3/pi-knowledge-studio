/** Host-bound model output used only to find original captured elements, never evidence. */
export interface VisionHint {
  readonly id: string;
  readonly documentId: string;
  readonly revision: string;
  readonly sourceHash: string;
  readonly imageId: string;
  readonly blobHash: string;
  readonly modelFingerprint: string;
  readonly promptFingerprint: string;
  readonly description: string;
  readonly descriptionHash: string;
  readonly authority: "retrieval-only";
}

/** Exact references and fingerprints supplied by the host, not by the model. */
export type VisionHintInput = Omit<
  VisionHint,
  "id" | "descriptionHash" | "authority"
>;

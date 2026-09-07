import { verifiedDisplay } from "../adapters/parsing/capture-image.ts";
import { sha256 } from "../adapters/blob/file-blob-store.ts";
import { join } from "node:path";
import { FileBlobStore } from "../adapters/blob/file-blob-store.ts";
import {
  describeImage,
  visionFingerprints,
  type GroundedModelOptions,
} from "../adapters/models/grounded-model.ts";
import { SqliteCatalog } from "../adapters/storage/sqlite-catalog.ts";
import type { VisionHint } from "../domain/vision-enrichment.ts";
import { dispatchAtEpoch } from "./knowledge-runtime.ts";
import { createVisionHint } from "./vision-hints.ts";

/** Explicitly approved PNG egress and persistence; never modifies source evidence. */
export async function enrichImage(
  root: string,
  documentId: string,
  imageId: string,
  prompt: string,
  modelRevision: string,
  options: GroundedModelOptions,
  persistenceApproved: boolean,
  approvedEpoch?: number,
): Promise<VisionHint> {
  const config = Object.freeze(structuredClone(options));
  if (config.approved !== true || persistenceApproved !== true)
    throw new Error("Vision egress and hint persistence must both be approved");
  const fingerprints = visionFingerprints(config, prompt, modelRevision);
  const snapshot = await SqliteCatalog.use(root, async (catalog) =>
    catalog.snapshot(),
  );
  if (approvedEpoch !== undefined && snapshot.epoch !== approvedEpoch)
    throw new Error("Sources changed since vision approval; retry explicitly");
  const document = snapshot.documents.find((item) => item.id === documentId);
  if (!document) throw new Error("Active document not found");
  const image = document.images.find((item) => item.id === imageId);
  if (!image) throw new Error("Captured image not found");
  const blobs = new FileBlobStore(join(root, "blobs"));
  await blobs.get(document.sourceHash);
  const { display: bytes } = await verifiedDisplay(image, blobs);
  const modelFingerprint = image.rendition
    ? sha256(JSON.stringify([fingerprints.modelFingerprint, image.rendition]))
    : fingerprints.modelFingerprint;
  const description = await dispatchAtEpoch(root, snapshot.epoch, () =>
    describeImage(config, bytes, prompt),
  );
  if (description.length > 16_000)
    throw new Error("Vision description exceeds 16000 character hint budget");
  const hint = createVisionHint(document, {
    documentId: document.id,
    revision: document.revision,
    sourceHash: document.sourceHash,
    imageId: image.id,
    blobHash: image.blobHash,
    ...fingerprints,
    modelFingerprint,
    description,
  });
  // Reverify physical source/image availability as well as logical catalog epoch.
  await blobs.get(document.sourceHash);
  await verifiedDisplay(image, blobs);
  await SqliteCatalog.use(root, async (catalog) =>
    catalog.saveHint(hint, snapshot.epoch),
  );
  return hint;
}

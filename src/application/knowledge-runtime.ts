import { verifyOcrRender } from "./verify-ocr-artifacts.ts";
import { effectiveOcrSignal, type OcrOptions } from "../adapters/parsing/local-pdf-ocr.ts";
import { OCR_WARNING, verifyOcrText } from "../domain/ocr.ts";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { FileBlobStore, sha256 } from "../adapters/blob/file-blob-store.ts";
import { SqliteCatalog } from "../adapters/storage/sqlite-catalog.ts";
import { captureLocal } from "../adapters/parsing/capture-local.ts";
import { exportPortableDocument } from "../adapters/export/portable-export.ts";
import { lexicalRank, cosine, reciprocalRankFusion } from "./rank-evidence.ts";
import { rerankEvidence } from "./rerank-evidence.ts";
import { lexicalHintHits } from "./vision-hints.ts";
import type { Reranker } from "../ports/reranker.ts";
import type {
  CapturedDocument,
  EmbeddingProvider,
  SearchHit,
} from "../domain/retrieval.ts";
import type {
  EvidenceBundle,
  ExportPermission,
  IllustratedDocument,
} from "../domain/evidence.ts";

/** Linearize provider entry with catalog writes, not provider completion.
 * invoke must enter the provider synchronously (no deferred microtask). Release
 * the write reservation before awaiting network/reentrant async catalog work.
 */
export async function dispatchAtEpoch<T>(
  root: string,
  epoch: number,
  invoke: () => Promise<T>,
): Promise<T> {
  return SqliteCatalog.use(root, async (catalog) => {
    catalog.db.exec("BEGIN IMMEDIATE");
    let pending: Promise<T>;
    try {
      if (catalog.epoch() !== epoch)
        throw new Error(
          "Sources changed before provider dispatch; retry explicitly",
        );
      pending = invoke();
    } catch (error) {
      catalog.db.exec("ROLLBACK");
      throw error;
    }
    try {
      catalog.db.exec("COMMIT");
    } catch (error) {
      // Invocation already happened; consume its failure if commit fails.
      void pending.catch(() => {});
      catalog.db.exec("ROLLBACK");
      throw error;
    }
    return await pending;
  });
}

export class KnowledgeRuntime {
  readonly root: string;
  readonly blobs: FileBlobStore;
  constructor(root: string) {
    this.root = root;
    this.blobs = new FileBlobStore(join(root, "blobs"));
  }

  async ingest(
    sourceRoot: string,
    path: string,
    options: { ocr?: OcrOptions; signal?: AbortSignal } = {},
  ): Promise<CapturedDocument> {
    options = { ...options, ...(options.ocr ? { ocr: { ...options.ocr } } : {}) };
    const signal = effectiveOcrSignal(options.signal, options.ocr?.signal);
    signal?.throwIfAborted();
    const epoch = await SqliteCatalog.use(this.root, async (catalog) =>
      catalog.epoch(),
    );
    const document = await captureLocal(
      sourceRoot,
      path,
      this.blobs,
      undefined,
      options,
    );
    signal?.throwIfAborted();
    await SqliteCatalog.use(this.root, async (catalog) => {
      // Last cooperative check, not atomic cancellation with catalog commit.
      signal?.throwIfAborted();
      catalog.publish(document, epoch);
    });
    return document;
  }

  async index(provider: EmbeddingProvider): Promise<{ documents: number }> {
    const snapshot = await SqliteCatalog.use(this.root, async (catalog) =>
      catalog.snapshot(),
    );
    for (const document of snapshot.documents) {
      await this.blobs.get(document.sourceHash);
      const vectors: number[][] = [];
      for (let offset = 0; offset < document.elements.length; offset += 16) {
        vectors.push(
          ...(await dispatchAtEpoch(this.root, snapshot.epoch, () =>
            provider.embed(
              document.elements
                .slice(offset, offset + 16)
                .map((element) => element.text),
              "document",
            ),
          )),
        );
      }
      await SqliteCatalog.use(this.root, async (catalog) =>
        catalog.saveVectors(document, provider.space, vectors, snapshot.epoch),
      );
    }
    return { documents: snapshot.documents.length };
  }

  async search(
    query: string,
    limit = 10,
    provider?: EmbeddingProvider,
    reranker?: Reranker,
  ): Promise<{
    bundle: EvidenceBundle;
    document: IllustratedDocument;
    hits: SearchHit[];
  }> {
    if (
      !query.trim() ||
      query.length > 8000 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 10
    )
      throw new Error("Invalid search query or limit");
    const snapshot = await SqliteCatalog.use(this.root, async (catalog) =>
      catalog.snapshot(provider?.space),
    );
    const lexical = lexicalRank(snapshot.documents, query);
    const dense: SearchHit[] = [];
    if (provider) {
      for (const entry of snapshot.documents)
        if (snapshot.vectors.get(entry.id)?.size !== entry.elements.length)
          throw new Error(
            "Incomplete embedding coverage; index this model space before hybrid search",
          );
      const vector = (
        await dispatchAtEpoch(this.root, snapshot.epoch, () =>
          provider.embed([query], "query"),
        )
      )[0];
      if (!vector || vector.length !== provider.space.dimension)
        throw new Error("Invalid query embedding");
      for (const entry of snapshot.documents)
        for (const element of entry.elements) {
          const stored = snapshot.vectors.get(entry.id)?.get(element.id);
          if (!stored) throw new Error("Missing embedding");
          const score = cosine(vector, stored);
          if (score > 0) dense.push({ document: entry, element, score });
        }
      dense.sort(
        (a, b) => b.score - a.score || a.element.id.localeCompare(b.element.id),
      );
    }
    const candidateLimit = reranker ? 30 : limit;
    const ranked = reciprocalRankFusion(lexical, dense, candidateLimit);
    // Reserve up to one third of the bounded pool for independent hint hits.
    // These hits contain original source fields, never description evidence.
    const hints = lexicalHintHits(
      query,
      snapshot.documents,
      snapshot.hints,
    ).slice(0, Math.ceil(candidateLimit / 3));
    const key = (hit: SearchHit) =>
      `${hit.document.id}:${hit.document.revision}:${hit.element.id}`;
    const reserved = new Set(hints.map(key));
    let hits = [
      ...ranked
        .filter((hit) => !reserved.has(key(hit)))
        .slice(0, candidateLimit - hints.length),
      ...hints,
    ];
    if (!hits.length) throw new Error("No relevant evidence found");
    if (reranker) {
      for (const hit of hits) await this.blobs.get(hit.document.sourceHash);
      hits = await dispatchAtEpoch(this.root, snapshot.epoch, () =>
        rerankEvidence(query, hits, reranker, limit),
      );
    }
    const bundle: EvidenceBundle = {
      schemaVersion: 1,
      id: `bundle_${randomUUID()}`,
      snapshotId: `epoch_${snapshot.epoch}`,
      sources: [],
      texts: [],
      images: [],
    };
    const document: IllustratedDocument = {
      title: query,
      bundleId: bundle.id,
      mode: "evidence-compilation",
      blocks: [],
    };
    for (const hit of hits) {
      const sourceId = hit.document.id;
      if (!bundle.sources.some((source) => source.id === sourceId))
        bundle.sources.push({
          id: sourceId,
          label:
            hit.document.label +
            (hit.element.provenance ? " [unverified OCR]" : ""),
          revisionHash: hit.document.revision,
        });
      const evidenceId = `text_${sha256(sourceId + hit.element.id)}`;
      bundle.texts.push({
        id: evidenceId,
        sourceId,
        elementId: hit.element.id,
        locator: hit.element.locator,
        text: hit.element.text,
        textHash: sha256(hit.element.text),
        ...(hit.element.provenance
          ? { provenance: hit.element.provenance }
          : {}),
        start: 0,
        end: hit.element.text.length,
      });
      document.blocks.push({
        kind: "paragraph",
        text:
          (hit.element.provenance ? OCR_WARNING + "\n" : "") + hit.element.text,
        evidenceIds: [evidenceId],
      });
      for (const image of hit.document.images.filter((image) =>
        image.elementIds.includes(hit.element.id),
      )) {
        const id = `figure_${sha256(sourceId + image.id)}`;
        if (
          bundle.images.some((item) => item.id === id) ||
          (bundle.images.length >= 5 && !image.provenance)
        )
          continue;
        bundle.images.push({
          id,
          sourceId,
          locator: image.locator,
          blobHash: image.blobHash,
          originKind: image.originKind,
          ...(image.provenance ? { provenance: image.provenance } : {}),
          ...(image.rendition ? { rendition: image.rendition } : {}),
        });
        document.blocks.push({
          kind: "figure",
          occurrenceId: id,
          caption: image.caption,
          evidenceIds: [evidenceId],
        });
      }
    }
    for (const hit of hits) {
      await this.blobs.get(hit.document.sourceHash);
      if (hit.element.provenance)
        await verifyOcrText(
          hit.element.text,
          hit.element.provenance,
          this.blobs,
        );
    }
    for (const image of bundle.images)
      if (image.provenance) await verifyOcrRender(image.provenance, this.blobs);
    await SqliteCatalog.use(this.root, async (catalog) => {
      if (catalog.epoch() !== snapshot.epoch)
        throw new Error("Sources changed during retrieval; retry explicitly");
    });
    return { bundle, document, hits };
  }

  async export(
    query: string,
    outputRoot: string,
    permission: ExportPermission,
    provider?: EmbeddingProvider,
  ): Promise<string> {
    const result = await this.search(query, 10, provider);
    // Recheck the epoch after asynchronous query embedding and before sharing a snapshot.
    await SqliteCatalog.use(this.root, async (catalog) => {
      if (`epoch_${catalog.epoch()}` !== result.bundle.snapshotId)
        throw new Error("Sources changed during retrieval; retry export");
    });
    return exportPortableDocument(
      outputRoot,
      result.bundle,
      result.document,
      permission,
      this.blobs,
    );
  }

  async list(): Promise<
    Array<{
      id: string;
      label: string;
      revision: string;
      elements: number;
      images: number;
    }>
  > {
    return SqliteCatalog.use(this.root, async (catalog) =>
      catalog.snapshot().documents.map((document) => ({
        id: document.id,
        label: document.label,
        revision: document.revision,
        elements: document.elements.length,
        images: document.images.length,
      })),
    );
  }

  async remove(documentId: string): Promise<boolean> {
    return SqliteCatalog.use(this.root, async (catalog) =>
      catalog.remove(documentId),
    );
  }
}

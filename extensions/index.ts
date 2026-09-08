import { studioPaths } from "../src/core/studio-paths.ts";
import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { access } from "node:fs/promises";
// @ts-ignore TS2691: Pi loads the TypeScript extension source through its Jiti loader.
import { loadConfig } from "../src/config.ts";
// @ts-ignore TS2691: Pi loads the TypeScript extension source through its Jiti loader.
import { ingestSource } from "../src/ingest/source-reader.ts";
// @ts-ignore TS2691: Pi loads the TypeScript extension source through its Jiti loader.
import { getProfile, listProfiles } from "../src/profiles/profile.ts";
// @ts-ignore TS2691: Pi loads the TypeScript extension source through its Jiti loader.
import { searchCollection } from "../src/retrieval/search.ts";
// @ts-ignore TS2691: Pi loads the TypeScript extension source through its Jiti loader.
import {
  collectionDirectory,
  collectionKey,
  loadCollection,
  saveCollection,
} from "../src/storage/store.ts";
// @ts-ignore TS2691: Pi loads the TypeScript extension source through its Jiti loader.
import {
  assertNoSymlinkPath,
  realpathWithin,
  safeRelativeResource,
} from "../src/core/path-safety.ts";
// @ts-ignore TS2691: Pi loads the TypeScript extension source through its Jiti loader.
import { renderMarkdown } from "../src/generation/markdown.ts";
// @ts-ignore TS2691: Pi loads the TypeScript extension source through its Jiti loader.
import { OpenAICompatibleVisionProvider } from "../src/vision/provider.ts";
// @ts-ignore TS2691: Pi loads the TypeScript extension source through its Jiti loader.
import type {
  AnnotationRecord,
  AssetRecord,
  SearchHit,
} from "../src/core/types.ts";

interface IngestParams {
  collection: string;
  path: string;
  profile?: string;
}

interface SearchParams {
  collection: string;
  query: string;
  limit?: number;
  includeAssets?: boolean;
}

interface GenerateMarkdownParams {
  collection: string;
  title: string;
  topic: string;
  query?: string;
  limit?: number;
  includeAssets?: boolean;
  notes?: string;
  profile?: string;
}

interface ExplainAssetParams {
  collection: string;
  assetId: string;
  prompt: string;
  useVision?: boolean;
}
// @ts-ignore TS2691: Pi loads the TypeScript extension source through its Jiti loader.
import { stableId } from "../src/core/provenance.ts";

const Collection = Type.String({ minLength: 1, maxLength: 96 });
const Query = Type.String({ minLength: 1, maxLength: 2000 });
const Limit = Type.Optional(Type.Integer({ minimum: 1, maximum: 50 }));

function checkedCollection(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("collection must not be empty.");
  return collectionKey(name);
}

function checkedQuery(value: string): string {
  const query = value.trim();
  if (!query) throw new Error("query must not be empty.");
  return query;
}

function checkedLimit(value: number | undefined): number {
  if (value === undefined) return 8;
  if (!Number.isSafeInteger(value) || value < 1 || value > 50)
    throw new Error("limit must be an integer from 1 to 50.");
  return value;
}

function checkedInputPath(cwd: string, input: string): string {
  const value = input.trim().replace(/^@/, "");
  if (!value || value.includes("\0"))
    throw new Error("path must be a valid non-empty path.");
  if (isAbsolute(value))
    throw new Error("path must be relative to the project cwd.");
  const projectRoot = resolve(cwd);
  const path = resolve(projectRoot, value);
  const outsideProject = relative(projectRoot, path);
  if (
    outsideProject === ".." ||
    outsideProject.startsWith(`..${sep}`) ||
    isAbsolute(outsideProject)
  )
    throw new Error("path must stay inside the project cwd.");
  const storage = relative(studioPaths(cwd).root, path);
  if (!storage || (!storage.startsWith(`..${sep}`) && storage !== ".." && !isAbsolute(storage)))
    throw new Error("Source must be outside Studio persistent storage.");
  return path;
}

function result(
  text: string,
  details: unknown = {},
): { content: [{ type: "text"; text: string }]; details: unknown } {
  return { content: [{ type: "text", text }], details };
}

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "knowledge_studio_ingest",
    label: "Knowledge Studio ingest",
    description:
      "Ingest a document or directory into a provenance-aware knowledge collection.",
    executionMode: "sequential",
    parameters: Type.Object({
      collection: Collection,
      path: Type.String({
        minLength: 1,
        description: "File or directory path, relative to the project cwd.",
      }),
      profile: Type.Optional(Type.String({ minLength: 1, maxLength: 96 })),
    }),
    async execute(
      _id: string,
      params: IngestParams,
      _signal: AbortSignal | undefined,
      _update: AgentToolUpdateCallback<unknown> | undefined,
      ctx: ExtensionContext,
    ) {
      const collection = checkedCollection(params.collection);
      const input = checkedInputPath(ctx.cwd, params.path);
      await access(input);
      const config = loadConfig(ctx.cwd);
      const profile = getProfile(params.profile || config.defaultProfile).id;
      const ingested = await ingestSource(
        config.dataRoot,
        collection,
        profile,
        input,
        config,
      );
      return result(
        `Ingested ${ingested.length} source(s) into ${collection}.`,
        { collection, profile, results: ingested },
      );
    },
  });

  pi.registerTool({
    name: "knowledge_studio_search",
    label: "Knowledge Studio search",
    description:
      "Search text chunks and optionally indexed assets in a knowledge collection.",
    parameters: Type.Object({
      collection: Collection,
      query: Query,
      limit: Limit,
      includeAssets: Type.Optional(Type.Boolean()),
    }),
    async execute(
      _id: string,
      params: SearchParams,
      _signal: AbortSignal | undefined,
      _update: AgentToolUpdateCallback<unknown> | undefined,
      ctx: ExtensionContext,
    ) {
      const collection = checkedCollection(params.collection);
      const query = checkedQuery(params.query);
      const limit = checkedLimit(params.limit);
      const data = await loadCollection(
        loadConfig(ctx.cwd).dataRoot,
        collection,
      );
      const hits = searchCollection(data, {
        collection,
        query,
        limit,
        includeAssets: params.includeAssets ?? false,
      });
      return result(JSON.stringify(hits), { collection, query, hits });
    },
  });

  pi.registerTool({
    name: "knowledge_studio_profiles",
    label: "Knowledge Studio profiles",
    description: "List the built-in knowledge extraction profiles.",
    parameters: Type.Object({}),
    async execute() {
      const profiles = listProfiles();
      return result(JSON.stringify(profiles), { profiles });
    },
  });

  pi.registerTool({
    name: "knowledge_studio_generate_markdown",
    label: "Knowledge Studio markdown",
    description:
      "Generate an evidence-cited Markdown draft from collection search results.",
    parameters: Type.Object({
      collection: Collection,
      title: Type.String({ minLength: 1, maxLength: 300 }),
      topic: Query,
      query: Type.Optional(Query),
      limit: Limit,
      includeAssets: Type.Optional(Type.Boolean()),
      notes: Type.Optional(Type.String({ maxLength: 10000 })),
      profile: Type.Optional(Type.String({ minLength: 1, maxLength: 96 })),
    }),
    async execute(
      _id: string,
      params: GenerateMarkdownParams,
      _signal: AbortSignal | undefined,
      _update: AgentToolUpdateCallback<unknown> | undefined,
      ctx: ExtensionContext,
    ) {
      const collection = checkedCollection(params.collection);
      const topic = checkedQuery(params.topic);
      const query = checkedQuery(params.query ?? topic);
      const data = await loadCollection(
        loadConfig(ctx.cwd).dataRoot,
        collection,
      );
      const hits = searchCollection(data, {
        collection,
        query,
        limit: checkedLimit(params.limit),
        includeAssets: params.includeAssets ?? true,
      });
      const assets = data.assets.filter((asset: AssetRecord) =>
        hits.some((hit: SearchHit) => hit.assetId === asset.id),
      );
      const draft = renderMarkdown({
        title: params.title.trim(),
        topic,
        profile: getProfile(params.profile ?? data.manifest.profile),
        hits,
        assets,
        ...(params.notes ? { notes: params.notes } : {}),
      });
      return result(draft, {
        collection,
        query,
        markdown: draft,
        hits,
        assets,
      });
    },
  });

  pi.registerTool({
    name: "knowledge_studio_explain_asset",
    label: "Knowledge Studio explain asset",
    description:
      "Explain an indexed image asset using configured vision, optionally recording an annotation.",
    executionMode: "sequential",
    parameters: Type.Object({
      collection: Collection,
      assetId: Type.String({ minLength: 1, maxLength: 128 }),
      prompt: Type.String({ minLength: 1, maxLength: 4000 }),
      useVision: Type.Optional(Type.Boolean()),
    }),
    async execute(
      _id: string,
      params: ExplainAssetParams,
      signal: AbortSignal | undefined,
      _update: AgentToolUpdateCallback<unknown> | undefined,
      ctx: ExtensionContext,
    ) {
      const collection = checkedCollection(params.collection);
      const dataRoot = loadConfig(ctx.cwd).dataRoot;
      const data = await loadCollection(dataRoot, collection);
      const asset: AssetRecord | undefined = data.assets.find(
        (item: AssetRecord) => item.id === params.assetId.trim(),
      );
      if (!asset)
        throw new Error(
          `Asset ${params.assetId} was not found in collection ${collection}.`,
        );
      if (asset.kind !== "image")
        throw new Error(
          "Vision explanations are only supported for image assets.",
        );
      const storedPathValue = asset.storedPath.trim();
      const storedPath = storedPathValue
        ? safeRelativeResource(dataRoot, storedPathValue)
        : undefined;
      const collectionRoot = resolve(collectionDirectory(dataRoot, collection));
      if (!storedPath || isAbsolute(storedPathValue))
        throw new Error("Asset storedPath must be relative to the data root.");
      const storedRelativeToCollection = relative(collectionRoot, storedPath);
      if (
        storedRelativeToCollection.startsWith("..") ||
        isAbsolute(storedRelativeToCollection)
      )
        throw new Error(
          "Asset storedPath is outside the collection directory.",
        );
      let text =
        asset.caption ?? asset.ocrText ?? "No existing explanation is stored.";
      let model: string | undefined;
      if (params.useVision ?? true) {
        await assertNoSymlinkPath(collectionRoot, storedPath);
        const canonicalStoredPath = await realpathWithin(
          collectionRoot,
          storedPath,
        );
        await access(canonicalStoredPath);
        const explanation = await new OpenAICompatibleVisionProvider(
          loadConfig(ctx.cwd),
        ).explain(
          {
            prompt: params.prompt.trim(),
            imagePath: canonicalStoredPath,
            imageRoot: collectionRoot,
          },
          signal,
        );
        text = explanation.text;
        model = explanation.model;
        const annotation: AnnotationRecord = {
          id: stableId(asset.id, "vision", text),
          assetId: asset.id,
          collection,
          type: "vision",
          text,
          ...(model ? { model } : {}),
          createdAt: new Date().toISOString(),
          metadata: {},
        };
        data.annotations = data.annotations
          .filter(
            (item: AnnotationRecord) =>
              !(item.assetId === asset.id && item.type === "vision"),
          )
          .concat(annotation);
        await saveCollection(dataRoot, data);
      }
      return result(text, {
        collection,
        asset,
        ...(model ? { model } : {}),
        vision: params.useVision ?? true,
      });
    },
  });
}

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
// @ts-ignore TS2691: Tests execute TypeScript directly with Node's strip-types loader.
import { GENERAL_PROFILE } from "../src/profiles/profile.ts";
// @ts-ignore TS2691: Tests execute TypeScript directly with Node's strip-types loader.
import {
  citationLabel,
  sha256Bytes,
  sha256Text,
  stableId,
} from "../src/core/provenance.ts";
// @ts-ignore TS2691: Tests execute TypeScript directly with Node's strip-types loader.
import { lexicalScore, splitText } from "../src/core/chunking.ts";
// @ts-ignore TS2691: Tests execute TypeScript directly with Node's strip-types loader.
import { renderMarkdown } from "../src/generation/markdown.ts";
// @ts-ignore TS2691: Tests execute TypeScript directly with Node's strip-types loader.
import { ingestSource } from "../src/ingest/source-reader.ts";
// @ts-ignore TS2691: Tests execute TypeScript directly with Node's strip-types loader.
import { searchAssets, searchCollection } from "../src/retrieval/search.ts";
// @ts-ignore TS2691: Tests execute TypeScript directly with Node's strip-types loader.
import {
  collectionDirectory,
  collectionKey,
  loadCollection,
  saveCollection,
  saveManifest,
} from "../src/storage/store.ts";
// @ts-ignore TS2691: Tests execute TypeScript directly with Node's strip-types loader.
import type { IngestResult, SearchHit } from "../src/core/types.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `pi-knowledge-${prefix}-`));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("pure core functions", () => {
  test("splitText normalizes input, chunks at boundaries, and overlaps", () => {
    const normalizedChunks = splitText("  one\r\ntwo\u0000\r\nthree  ", 7, 2);
    assert.ok(normalizedChunks.length > 0);
    assert.ok(
      normalizedChunks.every(
        (part: string) =>
          !part.includes("\r") &&
          !part.includes("\u0000") &&
          part === part.trim(),
      ),
    );
    assert.deepEqual(splitText(" \r\n\u0000 ", 10, 2), []);
    assert.deepEqual(splitText("abcdef", 3, 100), ["a", "b", "c", "def"]);
  });

  test("lexicalScore counts normalized term occurrences", () => {
    assert.equal(lexicalScore("Alpha beta", "alpha ALPHA beta"), 1.5);
    assert.equal(lexicalScore("中文", "中文中文"), 2);
    assert.equal(lexicalScore("---", "anything"), 0);
  });

  test("stable IDs and SHA-256 helpers are deterministic and byte-sensitive", () => {
    assert.equal(stableId("a", "b"), stableId("a", "b"));
    assert.notEqual(stableId("a", "b"), stableId("b", "a"));
    assert.equal(
      sha256Text("hello"),
      sha256Bytes(new TextEncoder().encode("hello")),
    );
    assert.equal(
      sha256Text("hello"),
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    assert.notEqual(
      sha256Bytes(new Uint8Array([0])),
      sha256Bytes(new Uint8Array([1])),
    );
  });

  test("citationLabel includes optional page and line ranges", () => {
    assert.equal(citationLabel({ sourceUri: "file.md" }), "file.md");
    assert.equal(
      citationLabel({
        sourceUri: "file.md",
        page: 3,
        lineStart: 8,
        lineEnd: 11,
      }),
      "file.md, p. 3, lines 8-11",
    );
    assert.equal(
      citationLabel({ sourceUri: "file.md", lineStart: 8 }),
      "file.md, lines 8-8",
    );
  });

  test("collectionKey sanitizes names and rejects names without safe characters", () => {
    assert.equal(
      collectionKey("  FreeRTOS / STM32: notes  "),
      "FreeRTOS-STM32-notes",
    );
    assert.equal(collectionKey("a".repeat(120)).length, 96);
    for (const invalid of ["", "   ", "../", "///"]) {
      assert.throws(
        () => collectionKey(invalid),
        /at least one safe character/,
      );
    }
    assert.equal(collectionKey("..."), "...");
    assert.equal(
      collectionDirectory("/tmp/root", "my notes"),
      "/tmp/root/collections/my-notes",
    );
  });
});

describe("JSON collection persistence", () => {
  test("saves and reloads records while refreshing manifest counts", async () => {
    const root = await temporaryDirectory("store");
    const initial = await loadCollection(root, "notes", "general");
    assert.equal(initial.manifest.documentCount, 0);
    initial.documents.push({
      id: "doc-1",
      collection: "notes",
      sourceUri: "/tmp/input.txt",
      title: "input",
      mimeType: "text/plain",
      sha256: "hash",
      importedAt: "2020-01-01T00:00:00.000Z",
      profile: "general",
      metadata: {},
    });
    initial.chunks.push({
      id: "chunk-1",
      documentId: "doc-1",
      collection: "notes",
      ordinal: 0,
      text: "persistent text",
      locator: { sourceUri: "/tmp/input.txt" },
      metadata: {},
    });
    await saveCollection(root, initial);
    const loaded = await loadCollection(root, "notes");
    assert.equal(loaded.manifest.documentCount, 1);
    assert.equal(loaded.manifest.chunkCount, 1);
    assert.equal(loaded.chunks[0]?.text, "persistent text");
    await saveManifest(root, loaded);
    assert.match(
      await readFile(
        join(collectionDirectory(root, "notes"), "manifest.json"),
        "utf8",
      ),
      /"schemaVersion": 1/,
    );
  });
});

describe("source ingestion and retrieval", () => {
  test("ingests Markdown, TXT, HTML, and JSON from a temporary directory", async () => {
    const root = await temporaryDirectory("data");
    const sources = await temporaryDirectory("sources");
    await mkdir(join(sources, "assets"));
    const markdownAsset = new Uint8Array([0, 1, 2, 255, 9]);
    await writeFile(join(sources, "assets", "diagram.bin"), markdownAsset);
    await writeFile(
      join(sources, "notes.md"),
      "# Notes\n\nRTOS queue evidence ![Diagram](assets/diagram.bin)",
    );
    await writeFile(
      join(sources, "plain.txt"),
      "Plain text scheduler evidence",
    );
    await writeFile(
      join(sources, "page.html"),
      "<html><script>ignore()</script><body>HTML mutex evidence</body></html>",
    );
    await writeFile(
      join(sources, "data.json"),
      JSON.stringify({ topic: "JSON semaphore evidence" }),
    );

    const results = await ingestSource(
      root,
      "test-collection",
      "general",
      sources,
      {
        dataRoot: root,
        defaultProfile: "general",
        maxChunkChars: 1000,
        chunkOverlapChars: 0,
        maxAssetBytes: 100,
        maxSourceBytes: 100000,
        maxPdfPages: 100,
        maxPdfImagePixels: 16_777_216,
        maxPdfExtractionMs: 120_000,
        maxExtractedTextChars: 1_000_000,
        maxVisionImagePixels: 40_000_000,
        maxVisionRequestBytes: 12_000_000,
      },
    );
    assert.equal(results.length, 4);
    assert.deepEqual(
      results.map((result: IngestResult) => result.document.mimeType).sort(),
      ["application/json", "text/html", "text/markdown", "text/plain"],
    );
    const markdown = results.find(
      (result: IngestResult) => result.document.mimeType === "text/markdown",
    );
    assert.ok(markdown);
    const [markdownAssetRecord] = markdown.assets;
    assert.ok(markdownAssetRecord);
    assert.equal(markdown.assets.length, 1);
    assert.deepEqual(
      [...(await readFile(join(root, markdownAssetRecord.storedPath)))],
      [...markdownAsset],
    );
    assert.equal(markdownAssetRecord.sha256, sha256Bytes(markdownAsset));
    assert.match(markdown.chunks[0]?.text ?? "", /RTOS queue evidence/);
    assert.doesNotMatch(
      results.find(
        (result: IngestResult) => result.document.mimeType === "text/html",
      )?.chunks[0]?.text ?? "",
      /script|ignore/,
    );

    const collection = await loadCollection(root, "test-collection");
    assert.equal(collection.documents.length, 4);
    assert.equal(collection.assets.length, 1);
    const hits = searchCollection(collection, {
      collection: "test-collection",
      query: "queue",
      includeAssets: true,
    });
    assert.equal(hits[0]?.kind, "chunk");
    assert.match(hits[0]?.text ?? "", /queue/);
    assert.equal(searchAssets(collection, "Diagram")[0]?.kind, "asset");
  });
});

describe("Markdown generation", () => {
  test("renders citations, assets, and escapes Markdown metacharacters", () => {
    const hit: SearchHit = {
      kind: "chunk",
      score: 1,
      text: "Evidence text",
      documentId: "doc",
      locator: { sourceUri: "a_[b].md", page: 2, lineStart: 4 },
    };
    const output = renderMarkdown({
      title: "A *title*",
      topic: "topic_[x]",
      profile: GENERAL_PROFILE,
      hits: [hit],
      assets: [
        {
          id: "asset",
          documentId: "doc",
          collection: "c",
          kind: "image",
          sourceUri: "image.png",
          storedPath: "collections/c/assets/image.png",
          mimeType: "image/png",
          sha256: "hash",
          locator: { sourceUri: "a.md" },
          title: "An [image]",
          metadata: {},
        },
      ],
      notes: "A note",
    });
    assert.equal(output.split("\n")[0], "# A \\*title\\*");
    assert.ok(output.includes("> Topic: topic\\_\\[x\\]"));
    assert.ok(output.includes("Source: a\\_\\[b\\].md, p. 2, lines 4-4"));
    assert.ok(output.includes("![An \\[image\\]]"));
    assert.match(output, /A note/);
  });
});

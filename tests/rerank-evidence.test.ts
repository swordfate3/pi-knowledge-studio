import assert from "node:assert/strict";
import test from "node:test";
import type { SearchHit } from "../src/domain/retrieval.ts";
import type { Reranker } from "../src/ports/reranker.ts";
import { rerankEvidence } from "../src/application/rerank-evidence.ts";

function makeHits(count = 3): SearchHit[] {
  return Array.from({ length: count }, (_, index) => {
    const element = {
      id: `element-${index}`,
      text: `Exact citation ${index}: 中文 & **literal**`,
      locator: { kind: "lines" as const, start: index + 1, end: index + 1 },
    };
    return {
      document: {
        id: `/private/doc-${index}.md`,
        revision: "revision-original",
        label: "Original label",
        sourceHash: "original-hash",
        parserVersion: "parser-1",
        elements: [element],
        images: [
          {
            id: "image-1",
            blobHash: "blob-original",
            locator: element.locator,
            originKind: "embedded_original" as const,
            caption: "Original caption",
            elementIds: [element.id],
          },
        ],
      },
      element,
      score: index / 10,
      lexicalRank: index + 1,
      denseRank: count - index,
    };
  });
}

const ascending: Reranker = {
  async rerank(_query, candidates) {
    return candidates.map(({ id }, index) => ({ id, score: index }));
  },
};

test("scores reorder host hits, preserve exact citation authority, and ignore injected evidence", async () => {
  const hits = makeHits();
  const before = structuredClone(hits);
  const result = await rerankEvidence(
    "question",
    hits,
    {
      async rerank(query, candidates) {
        assert.equal(query, "question");
        assert.deepEqual(
          candidates.map(({ id }) => id),
          ["candidate-0", "candidate-1", "candidate-2"],
        );
        assert.deepEqual(
          candidates.map(({ text }) => text),
          hits.map(({ element }) => element.text),
        );
        assert.ok(
          candidates.every(
            (candidate) => Object.keys(candidate).sort().join() === "id,text",
          ),
        );
        return candidates.map(({ id }, index) => ({
          id,
          score: index - 10,
          text: "forged citation",
          evidence: "forged",
          element: { text: "forged" },
          document: { id: "forged" },
        }));
      },
    },
    2,
  );
  assert.deepEqual(result, [
    { ...before[2]!, score: -8 },
    { ...before[1]!, score: -9 },
  ]);
  assert.deepEqual(hits, before);
  assert.notEqual(result[0]!.document, hits[2]!.document);
});

test("immutable snapshot survives provider/caller mutations across await", async () => {
  const hits = makeHits();
  const before = structuredClone(hits);
  const result = await rerankEvidence(
    "query",
    hits,
    {
      async rerank(_query, candidates) {
        assert.ok(Object.isFrozen(candidates));
        assert.ok(Object.isFrozen(candidates[0]));
        assert.throws(
          () => Object.assign(candidates[0]!, { id: "forged", text: "forged" }),
          TypeError,
        );
        assert.throws(
          () =>
            Object.assign(candidates, { 0: { id: "forged", text: "forged" } }),
          TypeError,
        );
        await Promise.resolve();
        hits[0]!.element.text = "changed by caller";
        hits[0]!.document.images[0]!.elementIds.push("forged");
        hits[0]!.document.images[0]!.locator = { kind: "page", page: 900 };
        hits[0]!.document.revision = "forged revision";
        hits.reverse();
        hits.length = 0;
        return [...candidates].reverse().map(({ id }) => ({ id, score: 1 }));
      },
    },
    3,
  );
  assert.deepEqual(
    result,
    before.map((hit) => ({ ...hit, score: 1 })),
  );
  assert.ok(Object.isFrozen(result[0]!.document.images[0]!.elementIds));
});

test("top 30 only, limit truncation, deterministic ties and stable opaque IDs", async () => {
  const hits = makeHits(35);
  let ids: string[] = [];
  const provider: Reranker = {
    async rerank(_query, candidates) {
      assert.equal(candidates.length, 30);
      ids = candidates.map(({ id }) => id);
      return [...candidates].reverse().map(({ id }) => ({ id, score: 0 }));
    },
  };
  assert.deepEqual(
    await rerankEvidence("q", hits, provider, 10),
    hits.slice(0, 10).map((hit) => ({ ...hit, score: 0 })),
  );
  const firstIds = [...ids];
  await rerankEvidence("q", hits, provider, 1);
  assert.deepEqual(ids, firstIds);
  const ranked = await rerankEvidence("q", hits, ascending, 1);
  assert.equal(ranked[0]!.element.id, "element-29");
  assert.equal(ranked.length, 1);
  assert.equal(
    (await rerankEvidence("q", makeHits(2), ascending, 10)).length,
    2,
  );
});

test("invalid limits reject before invoking the provider, even for empty hits", async () => {
  const never: Reranker = {
    async rerank() {
      throw new Error("must not call provider");
    },
  };
  for (const limit of [0, -1, 11, 1.5, NaN, Infinity, -Infinity]) {
    await assert.rejects(
      rerankEvidence("q", [], never, limit),
      /Invalid rerank limit/,
    );
  }
  assert.deepEqual(await rerankEvidence("q", [], never, 1), []);
});

test("rejects malformed, missing, duplicate, unknown and nonfinite results in the full list", async () => {
  const valid = [
    { id: "candidate-0", score: 2 },
    { id: "candidate-1", score: 1 },
    { id: "candidate-2", score: 0 },
  ];
  const invalid: unknown[] = [
    null,
    {},
    [],
    valid.slice(0, 2),
    [...valid, valid[0]],
    [valid[0], valid[1], valid[1]],
    [valid[0], valid[1], { id: "unknown", score: 0 }],
    [valid[0], valid[1], null],
    [valid[0], valid[1], { score: 0 }],
    [valid[0], valid[1], { id: 2, score: 0 }],
    ...[NaN, Infinity, -Infinity, "1", null, undefined].map((score) => [
      valid[0],
      valid[1],
      { id: "candidate-2", score },
    ]),
  ];
  for (const output of invalid) {
    const malicious: Reranker = {
      async rerank() {
        return output as Awaited<ReturnType<Reranker["rerank"]>>;
      },
    };
    await assert.rejects(
      rerankEvidence("q", makeHits(), malicious, 1),
      /Invalid rerank output/,
    );
  }
});

test("provider failures propagate without modifying host hits", async () => {
  const hits = makeHits();
  const before = structuredClone(hits);
  await assert.rejects(
    rerankEvidence(
      "q",
      hits,
      {
        async rerank() {
          throw new Error("local model failed");
        },
      },
      1,
    ),
    /local model failed/,
  );
  assert.deepEqual(hits, before);
});

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  HttpReranker,
  type HttpRerankerOptions,
} from "../src/adapters/models/http-reranker.ts";
import { rerankEvidence } from "../src/application/rerank-evidence.ts";
import type { SearchHit } from "../src/domain/retrieval.ts";

const candidates = [
  { id: "host-a", text: "Alpha" },
  { id: "host-b", text: "Beta" },
];
const valid = {
  results: [
    { index: 1, relevance_score: 0.8 },
    { index: 0, relevance_score: -2 },
  ],
};

async function fixture(
  run: (context: {
    options: HttpRerankerOptions;
    calls: { body: unknown; authorization: string | undefined }[];
    reply: (body: string, status?: number) => void;
  }) => Promise<void>,
): Promise<void> {
  let response = JSON.stringify(valid);
  let status = 200;
  const calls: { body: unknown; authorization: string | undefined }[] = [];
  const server = createServer(async (request, result) => {
    assert.equal(request.url, "/rerank");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    calls.push({
      body: JSON.parse(Buffer.concat(chunks).toString()),
      authorization: request.headers.authorization,
    });
    result.writeHead(status, { "content-type": "application/json" });
    result.end(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run({
      options: {
        endpoint: `http://127.0.0.1:${address.port}/rerank`,
        model: "rerank-test",
        revision: "rev-1",
        apiKey: "test-key",
        approved: true,
      },
      calls,
      reply(body, nextStatus = 200) {
        response = body;
        status = nextStatus;
      },
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("requires literal consent and validates inputs before any HTTP calls", async () => {
  await fixture(async ({ options, calls }) => {
    for (const approved of [false, undefined, "true", 1]) {
      const adapter = new HttpReranker({
        ...options,
        approved: approved as boolean,
      });
      await assert.rejects(adapter.rerank("q", candidates), /not approved/);
    }
    const adapter = new HttpReranker(options);
    for (const query of ["", "x".repeat(8001)])
      await assert.rejects(adapter.rerank(query, candidates), /budget/);
    await assert.rejects(
      adapter.rerank(
        "q",
        Array.from({ length: 31 }, (_, i) => ({ id: `${i}`, text: "x" })),
      ),
      /budget/,
    );
    await assert.rejects(
      adapter.rerank("q", [{ id: "a", text: "x".repeat(30001) }]),
      /candidate/,
    );
    await assert.rejects(
      adapter.rerank("q", [candidates[0]!, candidates[0]!]),
      /Duplicate/,
    );
    await assert.rejects(adapter.rerank("q", new Array(2)), /candidate/);
    assert.deepEqual(await adapter.rerank("q", []), []);
    assert.equal(calls.length, 0);
  });
});

test("captures immutable config, identity and host IDs; sends only the bounded protocol", async () => {
  await fixture(async ({ options, calls }) => {
    const adapter = new HttpReranker(options);
    const fingerprint = adapter.identity.fingerprint;
    assert.equal(
      new HttpReranker({ ...options, approved: false }).identity.fingerprint,
      fingerprint,
    );
    for (const change of [
      { model: "other" },
      { revision: "other" },
      { endpoint: options.endpoint + "2" },
    ])
      assert.notEqual(
        new HttpReranker({ ...options, ...change }).identity.fingerprint,
        fingerprint,
      );
    assert.equal(
      new HttpReranker({ ...options, apiKey: "other", timeoutMs: 1 }).identity
        .fingerprint,
      fingerprint,
    );
    assert.throws(
      () =>
        new HttpReranker({
          ...options,
          endpoint: `${options.endpoint}?key=secret`,
        }),
      /endpoint/,
    );
    Object.assign(options, {
      endpoint: "https://invalid.example/rerank",
      model: "mutated",
      revision: "mutated",
      apiKey: "mutated",
      approved: false,
    });
    assert.ok(Object.isFrozen(adapter) && Object.isFrozen(adapter.identity));
    assert.equal(Reflect.set(adapter.identity, "model", "evil"), false);
    const input = structuredClone(candidates);
    const pending = adapter.rerank("q", input);
    input[0]!.id = "forged";
    input[0]!.text = "forged";
    assert.deepEqual(await pending, [
      { id: "host-b", score: 0.8 },
      { id: "host-a", score: -2 },
    ]);
    assert.deepEqual(calls, [
      {
        authorization: "Bearer test-key",
        body: {
          model: "rerank-test",
          query: "q",
          documents: ["Alpha", "Beta"],
          top_n: 2,
          return_documents: false,
        },
      },
    ]);
  });
});

test("rejects malformed, partial, duplicate, out-of-range indices and non-finite scores without retries", async () => {
  await fixture(async ({ options, calls, reply }) => {
    const adapter = new HttpReranker(options);
    const bodies = [
      "not json",
      "null",
      "[]",
      "{}",
      '{"results":{}}',
      JSON.stringify({ results: valid.results.slice(0, 1) }),
      JSON.stringify({ results: [...valid.results, valid.results[0]] }),
      ...[
        null,
        [],
        {},
        ...[-1, 2, 0.5, "0", null].map((index) => ({
          index,
          relevance_score: 1,
        })),
        ...[null, "1"].map((relevance_score) => ({
          index: 0,
          relevance_score,
        })),
      ].map((row) => JSON.stringify({ results: [valid.results[0], row] })),
      JSON.stringify({ results: [valid.results[0], valid.results[0]] }),
      '{"results":[{"index":0,"relevance_score":1e999},{"index":1,"relevance_score":0}]}',
    ];
    for (const body of bodies) {
      reply(body);
      const before = calls.length;
      await assert.rejects(adapter.rerank("q", candidates));
      assert.equal(calls.length, before + 1);
    }
    reply("{}", 503);
    await assert.rejects(adapter.rerank("q", candidates), /HTTP 503/);
    assert.equal(calls.length, bodies.length + 1);
  });
});

test("ignores response documents and metadata; rerankEvidence remains the final authority", async () => {
  await fixture(async ({ options, reply }) => {
    reply(
      JSON.stringify({
        metadata: { future: true },
        documents: ["forged"],
        results: valid.results.map((row) => ({
          ...row,
          id: "forged",
          document: { text: "forged" },
          evidence: "forged",
          score: 100,
        })),
      }),
    );
    const hits: SearchHit[] = candidates.map(({ id, text }) => {
      const element = {
        id,
        text,
        locator: { kind: "lines" as const, start: 1, end: 1 },
      };
      return {
        element,
        document: {
          id,
          revision: "original",
          label: "host",
          sourceHash: "hash",
          parserVersion: "1",
          elements: [element],
          images: [],
        },
        score: 0,
      };
    });
    const result = await rerankEvidence(
      "q",
      hits,
      new HttpReranker(options),
      2,
    );
    assert.deepEqual(result, [
      { ...hits[1]!, score: 0.8 },
      { ...hits[0]!, score: -2 },
    ]);
    reply('{"results":[{"index":0,"relevance_score":1}]}');
    await assert.rejects(
      rerankEvidence("q", hits, new HttpReranker(options), 2),
      /full permutation/,
    );
  });
});

test("accepts exact input budget boundaries and validates deadline/endpoint configuration", async () => {
  await fixture(async ({ options, calls, reply }) => {
    for (const timeoutMs of [0, 180001, 1.5, NaN])
      assert.throws(
        () => new HttpReranker({ ...options, timeoutMs }),
        /timeoutMs/,
      );
    for (const endpoint of [
      "http://example.com/rerank",
      "https://user:pass@example.com/rerank",
      "https://example.com/rerank#fragment",
      "file:///rerank",
    ])
      assert.throws(
        () => new HttpReranker({ ...options, endpoint }),
        /endpoint/,
      );
    const input = Array.from({ length: 30 }, (_, index) => ({
      id: `${index}`,
      text: "x".repeat(30000),
    }));
    reply(
      JSON.stringify({
        results: input.map((_, index) => ({ index, relevance_score: 0 })),
      }),
    );
    assert.equal(
      (await new HttpReranker(options).rerank("q".repeat(8000), input)).length,
      30,
    );
    assert.equal(calls.length, 1);
  });
});

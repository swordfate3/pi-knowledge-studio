import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { boundedJsonPost, HttpEmbeddingProvider } from "../src/adapters/models/http-embedding.ts";

test("OpenAI embeddings validate counts, ordering, identity and explicit egress permission", async () => {
  let mode = "ok",
    requests = 0;
  const server = createServer(async (request, response) => {
    requests++;
    for await (const _ of request) {
      /* drain fixture */
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        model: mode === "identity" ? "other" : "test",
        data: [
          {
            index: mode === "index" ? 2 : 0,
            embedding: mode === "zero" ? [0, 0] : [1, 0],
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const options = {
      endpoint: `http://127.0.0.1:${address.port}/embeddings`,
      kind: "openai" as const,
      approved: true,
      space: {
        provider: "fixture",
        model: "test",
        revision: "configured-pin",
        dimension: 2,
        queryInstruction: "",
        documentInstruction: "",
      },
    };
    await assert.rejects(
      new HttpEmbeddingProvider({ ...options, approved: false }).embed(
        ["private"],
        "query",
      ),
      /approved/,
    );
    assert.equal(requests, 0);
    const provider = new HttpEmbeddingProvider(options);
    assert.deepEqual(await provider.embed(["test"], "document"), [[1, 0]]);
    mode = "identity";
    await assert.rejects(provider.embed(["test"], "query"), /identity/);
    mode = "index";
    await assert.rejects(provider.embed(["test"], "query"), /indices/);
    mode = "zero";
    await assert.rejects(provider.embed(["test"], "query"), /vector/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});


test("transport deadlines bound headers and body, validate before egress and preserve other errors", async () => {
  let requests = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer(async (request, response) => {
    requests++;
    for await (const _ of request) { /* drain fixture */ }
    if (request.url === "/http-error") {
      response.writeHead(503).end();
      return;
    }
    if (request.url === "/json-error") {
      response.end("not json");
      return;
    }
    if (request.url === "/body") {
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      response.end(request.url === "/body" ? '"ok":true}' : '{"ok":true}');
    }, request.url === "/success" ? 50 : 2000);
    timers.add(timer);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const endpoint = `http://127.0.0.1:${address.port}`;
    for (const timeoutMs of [0, -1, 1.5, 180001, NaN, Infinity, "100", null]) {
      await assert.rejects(
        boundedJsonPost(endpoint, {}, undefined, { timeoutMs: timeoutMs as number }),
        /Invalid model timeoutMs/,
      );
    }
    assert.equal(requests, 0);
    assert.deepEqual(await boundedJsonPost(`${endpoint}/success`, {}, undefined, { timeoutMs: 1000 }), { ok: true });
    for (const path of ["headers", "body"]) {
      const start = performance.now();
      await assert.rejects(
        boundedJsonPost(`${endpoint}/${path}`, {}, undefined, { timeoutMs: 100 }),
        /Model request timed out after 100 ms/,
      );
      assert.ok(performance.now() - start < 1500, "deadline must bound the whole response");
    }
    assert.equal(requests, 3, "one request per invocation, no retries");
    await assert.rejects(boundedJsonPost(`${endpoint}/http-error`, {}), /Model HTTP 503/);
    await assert.rejects(boundedJsonPost(`${endpoint}/json-error`, {}), /Invalid model response JSON/);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

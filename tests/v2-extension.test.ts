import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import v2 from "../extensions/v2.ts";
import type { AnswerWireResponse } from "../src/domain/answer.ts";
import { encodePng } from "../src/adapters/export/encode-png.ts";
import { KnowledgeRuntime } from "../src/application/knowledge-runtime.ts";
import { HttpEmbeddingProvider } from "../src/adapters/models/http-embedding.ts";

function register(env: Record<string, string> = {}) {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env))
    if (key.startsWith("PI_KS_V2_")) delete process.env[key];
  Object.assign(process.env, env);
  const tools = new Map<string, ToolDefinition>();
  try {
    // Test double exposes only registration; load must not call other host APIs.
    v2({
      registerCommand() {},
      registerTool(tool: ToolDefinition) {
        tools.set(tool.name, tool);
      },
    } as unknown as ExtensionAPI);
  } finally {
    for (const key of Object.keys(process.env))
      if (key.startsWith("PI_KS_V2_")) delete process.env[key];
    Object.assign(process.env, saved);
  }
  return tools;
}
function registerFor(cwd: string, env: Record<string, string> = {}) {
  return register({ ...env, PI_KS_V2_DATA_DIR: join(cwd, ".pi", "knowledge-studio") });
}
function context(
  cwd: string,
  confirm?: (title: string, message: string) => Promise<boolean>,
) {
  return {
    cwd,
    hasUI: !!confirm,
    ui: { confirm },
    signal: undefined,
  } as unknown as ExtensionContext;
}
async function invoke(
  tools: Map<string, ToolDefinition>,
  name: string,
  params: Record<string, unknown>,
  ctx: ExtensionContext,
) {
  const tool = tools.get(name);
  assert.ok(tool, name);
  return tool.execute("test", params, undefined, undefined, ctx);
}
const modelEnv = {
  PI_KS_V2_GENERATE_ENDPOINT: "http://127.0.0.1:9876/v1/chat/completions",
  PI_KS_V2_GENERATE_MODEL: "generation-fixture",
  PI_KS_V2_VISION_ENDPOINT: "http://127.0.0.1:9876/v1/chat/completions",
  PI_KS_V2_VISION_MODEL: "vision-fixture",
};

test("V2 registers additive tools without writes/network; headless defaults deny", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ks-v2-extension-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const network = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected network");
  });
  const tools = registerFor(cwd, modelEnv);
  assert.deepEqual(
    [...tools.keys()].sort(),
    [
      "import",
      "search",
      "index",
      "export",
      "generate",
      "pdf_start", "pdf_resume", "pdf_status", "pdf_search",
      "profile_list", "profile_add", "profile_select", "pdf_migrate", "pdf_reindex",
      "pdf_generation_status", "pdf_generation_pause", "pdf_generation_cancel", "pdf_generation_resume",
      "pdf_generation_activate", "pdf_generation_rollback", "pdf_generation_search", "pdf_generation_associate",
      "describe_image",
      "enrich_image",
      "document",
      "remove",
      "list",
    ]
      .map((n) => `ks_v2_${n}`)
      .sort(),
  );
  assert.deepEqual(await readdir(cwd), []);
  for (const [name, params] of [
    ["import", { collection: "demo", path: "input.pdf" }],
    ["search", { collection: "demo", query: "hello" }],
    ["index", { collection: "demo" }],
    ["export", { collection: "demo", query: "hello", output: "report" }],
    [
      "generate",
      { collection: "demo", query: "hello", title: "Report", output: "report" },
    ],
    ["remove", { collection: "demo", documentId: `doc_${"a".repeat(64)}` }],
    ["list", { collection: "demo" }],
    ["document", { collection: "demo", documentId: `doc_${"a".repeat(64)}` }],
  ] as const)
    await assert.rejects(
      invoke(tools, `ks_v2_${name}`, params, context(cwd)),
      /denied/,
    );
  assert.deepEqual(await readdir(cwd), []);
  await writeFile(
    join(cwd, "image.png"),
    encodePng(1, 1, 3, Buffer.from([0, 0, 0])),
  );
  await assert.rejects(
    invoke(
      tools,
      "ks_v2_describe_image",
      { path: "image.png", prompt: "Describe" },
      context(cwd),
    ),
    /vision denied/,
  );
  assert.equal(network.mock.callCount(), 0);
});

test("generation approves actual bundle before egress and all sharing before export", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ks-v2-generation-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const tools = registerFor(cwd, {
    ...modelEnv,
    PI_KS_V2_GENERATE_API_KEY: "fixture-key",
    PI_KS_V2_GENERATE_TIMEOUT_MS: "180000",
  });
  const timeout = t.mock.method(AbortSignal, "timeout");
  const approvals: string[] = [];
  const ctx = context(cwd, async (title, message) => {
    approvals.push(title.split(": ")[1]!);
    if (title.endsWith("generate")) {
      assert.match(message, /Hello evidence/);
      assert.match(message, /revisionHash/);
      assert.match(message, /No PNG bytes/);
      assert.match(message, /Request deadline: 180000 ms/);
      assert.doesNotMatch(message, /fixture-key/);
      const preview = JSON.parse(message.slice(message.indexOf("\n") + 1));
      assert.equal(preview.question, "Hello");
      assert.equal(preview.title, "Report");
      assert.equal(preview.figurePolicy, "selective");
    }
    if (title.endsWith("export")) {
      assert.match(message, /supplementary excerpts/);
      assert.match(message, /INCLUDING metadata/);
    }
    return true;
  });
  await writeFile(join(cwd, "input.txt"), "Hello evidence");
  await invoke(
    tools,
    "ks_v2_import",
    { collection: "demo", path: "input.txt" },
    ctx,
  );
  const network = t.mock.method(
    globalThis,
    "fetch",
    async (_url: string | URL | Request, init?: RequestInit) => {
      assert.equal(approvals.at(-1), "generate");
      assert.equal(
        (init?.headers as Record<string, string>).authorization,
        "Bearer fixture-key",
      );
      const request = JSON.parse(String(init?.body));
      assert.equal(request.model, "generation-fixture");
      const { question, title, figurePolicy, bundle, hostDerivedFigureCandidates } = JSON.parse(request.messages[1].content);
      assert.equal(question, "Hello");
      assert.equal(title, "Report");
      assert.equal(figurePolicy, "selective");
      assert.deepEqual(hostDerivedFigureCandidates, []);
      assert.equal(request.response_format.json_schema.name, "grounded_answer_v2");
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                wireVersion: "grounded-answer-v2",
                status: "answered",
                requirements: [{ id: "r1", requirement: question, status: "supported", evidenceIds: [bundle.texts[0].id] }],
                figures: [],
                paragraphs: [
                  {
                    text: "Hello evidence",
                    evidenceIds: [bundle.texts[0].id],
                    requirementIds: ["r1"],
                  },
                ],
              } satisfies AnswerWireResponse),
            },
          },
        ],
      });
    },
  );
  const result = await invoke(
    tools,
    "ks_v2_generate",
    { collection: "demo", query: "Hello", title: "Report", output: "report" },
    ctx,
  );
  assert.match(JSON.stringify(result), /model-generated/);
  assert.match(JSON.stringify(result), /semanticProof/);
  assert.deepEqual(approvals, ["import", "search", "generate", "export"]);
  assert.equal(network.mock.callCount(), 1);
  assert.deepEqual(
    timeout.mock.calls.map((call) => call.arguments[0]),
    [180000],
  );
  assert.equal(
    (await readdir(join(cwd, ".pi", "knowledge-studio", "exports", "report"))).length,
    1,
  );
});

test("generation honors none, selective and required with host-linked answer figures", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ks-v2-answer-policy-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await enrichmentFixture(cwd);
  const tools = registerFor(cwd, modelEnv);
  for (const policy of ["none", "selective", "required"] as const) {
    const question = "Explain the Original captured text";
    const approvals: string[] = [];
    const network = t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      const input = JSON.parse(request.messages[1].content);
      assert.equal(input.question, question);
      assert.equal(input.title, "Separate display title");
      assert.equal(input.figurePolicy, policy);
      assert.equal(request.response_format.json_schema.name, "grounded_answer_v2");
      const candidate = input.hostDerivedFigureCandidates[0];
      assert.ok(candidate);
      const evidenceIds = [candidate.linkedTextIds[0]];
      assert.ok(input.bundle.texts.some((text: { id: string }) => text.id === evidenceIds[0]));
      assert.ok(input.bundle.images.some((image: { id: string }) => image.id === candidate.occurrenceId));
      // Selective may omit a figure despite available candidates; required selects one.
      const selected = policy === "required";
      const answer: AnswerWireResponse = {
        wireVersion: "grounded-answer-v2",
        status: "answered",
        requirements: [{ id: "r1", requirement: question, status: "supported", evidenceIds }],
        figures: selected ? [{ occurrenceId: candidate.occurrenceId, requirementId: "r1", evidenceIds, justification: "Accompany the captured-text explanation with its host-linked source illustration; no pixel verification." }] : [],
        paragraphs: [
          { text: "Original captured text.", evidenceIds, requirementIds: ["r1"] },
        ],
      };
      return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(answer) } }] });
    });
    try {
      const response = await invoke(tools, "ks_v2_generate", {
        collection: "demo", query: question, title: "Separate display title", figurePolicy: policy, output: policy,
      }, context(cwd, async (title, message) => {
        approvals.push(title.split(": ")[1]!);
        if (title.endsWith("generate")) {
          const preview = JSON.parse(message.slice(message.indexOf("\n") + 1));
          assert.equal(preview.question, question);
          assert.equal(preview.title, "Separate display title");
          assert.equal(preview.figurePolicy, policy);
        }
        return true;
      }));
      const content = response.content[0]!;
      assert.equal(content.type, "text");
      if (content.type !== "text") throw new Error("Expected answer result");
      const result = JSON.parse(content.text);
      assert.equal(result.status, "answered");
      assert.equal(result.assessment.question, question);
      assert.equal(result.assessment.semanticProof, false);
      assert.equal(result.assessment.figures.length, policy === "required" ? 1 : 0);
      const markdown = await readFile(join(result.path, "document.md"), "utf8");
      assert.equal(markdown.includes("!["), policy === "required");
      assert.deepEqual(approvals, ["search", "generate", "export"]);
      assert.equal(network.mock.callCount(), 1);
    } finally {
      network.mock.restore();
    }
  }
});

test("generation denial and source epoch changes prevent model egress", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ks-v2-epoch-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const tools = registerFor(cwd, modelEnv);
  await writeFile(join(cwd, "input.txt"), "Hello evidence");
  await invoke(
    tools,
    "ks_v2_import",
    { collection: "demo", path: "input.txt" },
    context(cwd, async () => true),
  );
  const network = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected network");
  });
  const params = {
    collection: "demo",
    query: "Hello",
    title: "Report",
    output: "report",
  };
  await assert.rejects(
    invoke(
      tools,
      "ks_v2_generate",
      params,
      context(cwd, async (title) => !title.endsWith("generate")),
    ),
    /generate denied/,
  );
  await assert.rejects(
    invoke(
      tools,
      "ks_v2_generate",
      params,
      context(cwd, async (title) => {
        if (title.endsWith("generate")) {
          const kb = new KnowledgeRuntime(
            join(cwd, ".pi", "knowledge-studio", "collections", "demo"),
          );
          await kb.remove((await kb.list())[0]!.id);
        }
        return true;
      }),
    ),
    /Sources changed during generation/,
  );
  assert.equal(network.mock.callCount(), 0);
});

test("vision uses approved raw PNG and returns untrusted, non-indexed description", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ks-v2-vision-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const bytes = encodePng(1, 1, 3, Buffer.from([255, 0, 0]));
  await writeFile(join(cwd, "image.png"), bytes);
  const tools = registerFor(cwd, modelEnv);
  const timeout = t.mock.method(AbortSignal, "timeout");
  let approved = false;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string | URL | Request, init?: RequestInit) => {
      assert.equal(approved, true);
      const request = JSON.parse(String(init?.body));
      assert.equal(request.model, "vision-fixture");
      assert.equal(
        request.messages[1].content[1].image_url.url,
        `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
      );
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "Probably red." },
          },
        ],
      });
    },
  );
  const result = await invoke(
    tools,
    "ks_v2_describe_image",
    { path: "image.png", prompt: "Describe" },
    context(cwd, async (_title, message) => {
      assert.match(message, /INCLUDING metadata/);
      assert.match(message, /SHA256/);
      assert.match(message, /Request deadline: 30000 ms/);
      approved = true;
      return true;
    }),
  );
  assert.match(JSON.stringify(result), /Untrusted description/);
  assert.deepEqual(
    timeout.mock.calls.map((call) => call.arguments[0]),
    [30000],
  );
  assert.deepEqual(await readdir(cwd), ["image.png"]);
});

test("embedding provider is bound to exact operation purpose", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ks-v2-purpose-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const tools = registerFor(cwd, {
    PI_KS_V2_HEADLESS_GRANTS: "import,search,embedding,index,export",
    PI_KS_V2_EMBED_ENDPOINT: "http://127.0.0.1:9876/embed",
    PI_KS_V2_EMBED_KIND: "openai",
    PI_KS_V2_EMBED_PROVIDER: "fixture",
    PI_KS_V2_EMBED_MODEL: "fixture",
    PI_KS_V2_EMBED_REVISION: "1",
    PI_KS_V2_EMBED_DIMENSION: "2",
  });
  const ctx = context(cwd);
  await writeFile(join(cwd, "input.txt"), "Hello evidence");
  await invoke(
    tools,
    "ks_v2_import",
    { collection: "demo", path: "input.txt" },
    ctx,
  );
  const purposes: string[] = [];
  t.mock.method(
    HttpEmbeddingProvider.prototype,
    "embed",
    async function (
      this: HttpEmbeddingProvider,
      texts: string[],
      purpose: "query" | "document",
    ) {
      assert.deepEqual(this.options.allowedPurposes, [purpose]);
      purposes.push(purpose);
      return texts.map(() => [1, 0]);
    },
  );
  await invoke(tools, "ks_v2_index", { collection: "demo" }, ctx);
  await invoke(
    tools,
    "ks_v2_search",
    { collection: "demo", query: "Hello", mode: "hybrid" },
    ctx,
  );
  await invoke(
    tools,
    "ks_v2_export",
    { collection: "demo", query: "Hello", mode: "hybrid", output: "report" },
    ctx,
  );
  assert.deepEqual(purposes, ["document", "query", "query"]);
});

test("PDF import returns explicit capture limitations", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ks-v2-pdf-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "input.pdf"), "%PDF-fixture");
  const tools = registerFor(cwd, { PI_KS_V2_HEADLESS_GRANTS: "import" });
  // Parser correctness belongs to pdf-capture tests; exercise extension acceptance/result.
  t.mock.method(KnowledgeRuntime.prototype, "ingest", async () => ({
    id: "fixture",
    revision: "revision",
    elements: [],
    images: [],
  }));
  const result = await invoke(
    tools,
    "ks_v2_import",
    { collection: "demo", path: "input.pdf" },
    context(cwd),
  );
  assert.match(JSON.stringify(result), /PDF_CAPTURE_LIMITATIONS/);
  assert.match(JSON.stringify(result), /without OCR/);
  assert.match(JSON.stringify(result), /decoded_embedded/);
});

test("source changes after model response block export", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ks-v2-stale-export-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "input.txt"), "Hello evidence");
  const tools = registerFor(cwd, modelEnv);
  const ctx = context(cwd, async (title) => {
    if (title.endsWith("export")) {
      const kb = new KnowledgeRuntime(
        join(cwd, ".pi", "knowledge-studio", "collections", "demo"),
      );
      await kb.remove((await kb.list())[0]!.id);
    }
    return true;
  });
  await invoke(
    tools,
    "ks_v2_import",
    { collection: "demo", path: "input.txt" },
    ctx,
  );
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string | URL | Request, init?: RequestInit) => {
      const { question, title, figurePolicy, bundle } = JSON.parse(
        JSON.parse(String(init?.body)).messages[1].content,
      );
      assert.equal(question, "Hello");
      assert.equal(title, "Report");
      assert.equal(figurePolicy, "selective");
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                wireVersion: "grounded-answer-v2",
                status: "answered",
                requirements: [{ id: "r1", requirement: question, status: "supported", evidenceIds: [bundle.texts[0].id] }],
                figures: [],
                paragraphs: [
                  {
                    text: "Hello evidence",
                    evidenceIds: [bundle.texts[0].id],
                    requirementIds: ["r1"],
                  },
                ],
              } satisfies AnswerWireResponse),
            },
          },
        ],
      });
    },
  );
  await assert.rejects(
    invoke(
      tools,
      "ks_v2_generate",
      { collection: "demo", query: "Hello", title: "Report", output: "report" },
      ctx,
    ),
    /Sources changed during generation/,
  );
  assert.deepEqual(
    await readdir(join(cwd, ".pi", "knowledge-studio", "exports", "report")),
    [],
  );
});

test("malformed trusted model deadlines deny before approval, reads or network", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ks-v2-deadline-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const network = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected network");
  });
  for (const kind of ["GENERATE", "VISION"] as const) {
    for (const value of [
      "",
      " ",
      " 1",
      "1 ",
      "01",
      "0",
      "-1",
      "+1",
      "1.5",
      "1e3",
      "0x10",
      "NaN",
      "Infinity",
      "180001",
      "999999999999999999999",
    ]) {
      const key = `PI_KS_V2_${kind}_TIMEOUT_MS`;
      const tools = registerFor(cwd, { ...modelEnv, [key]: value });
      await assert.rejects(
        invoke(
          tools,
          kind === "GENERATE" ? "ks_v2_generate" : "ks_v2_describe_image",
          kind === "GENERATE"
            ? {
                collection: "demo",
                query: "Hello",
                title: "Report",
                output: "report",
              }
            : { path: "missing.png", prompt: "Describe" },
          context(cwd, async () => {
            assert.fail("approval must not precede config validation");
          }),
        ),
        new RegExp(`${key} must be a strict integer 1\\.\\.180000`),
      );
    }
  }
  assert.equal(network.mock.callCount(), 0);
  assert.deepEqual(await readdir(cwd), []);
});

test("vision passes its independent trusted deadline to transport", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ks-v2-vision-deadline-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(
    join(cwd, "image.png"),
    encodePng(1, 1, 3, Buffer.from([0, 0, 0])),
  );
  const tools = registerFor(cwd, {
    ...modelEnv,
    PI_KS_V2_VISION_TIMEOUT_MS: "1",
    PI_KS_V2_GENERATE_TIMEOUT_MS: "180000",
  });
  const timeout = t.mock.method(AbortSignal, "timeout");
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: "Black." },
        },
      ],
    }),
  );
  await invoke(
    tools,
    "ks_v2_describe_image",
    { path: "image.png", prompt: "Describe" },
    context(cwd, async (_title, message) => {
      assert.match(message, /Request deadline: 1 ms/);
      return true;
    }),
  );
  assert.deepEqual(
    timeout.mock.calls.map((call) => call.arguments[0]),
    [1],
  );
});

test("DOCX import reports restricted capture and Python prerequisite, retaining default deny", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ks-v2-docx-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, "input.docx"), "DOCX-fixture");
  const network = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected network");
  });
  const ingest = t.mock.method(
    KnowledgeRuntime.prototype,
    "ingest",
    async () => ({
      id: "fixture",
      revision: "revision",
      elements: [],
      images: [],
    }),
  );
  const tools = registerFor(cwd);
  const params = { collection: "demo", path: "input.docx" };
  await assert.rejects(
    invoke(tools, "ks_v2_import", params, context(cwd)),
    /import denied/,
  );
  assert.equal(ingest.mock.callCount(), 0);
  const result = await invoke(
    tools,
    "ks_v2_import",
    params,
    context(cwd, async (_title, message) => {
      assert.match(message, /Restricted main-body text \+ PNG\/JPEG\/WebP/);
      assert.match(message, /Python 3 required/);
      return true;
    }),
  );
  assert.match(JSON.stringify(result), /DOCX_CAPTURE_LIMITATIONS/);
  assert.match(
    JSON.stringify(result),
    /Restricted main-body text \+ PNG\/JPEG\/WebP/,
  );
  assert.match(JSON.stringify(result), /Python 3 required/);
  assert.equal(ingest.mock.callCount(), 1);
  assert.equal(network.mock.callCount(), 0);
});

async function enrichmentFixture(cwd: string) {
  const bytes = encodePng(1, 1, 3, Buffer.from([255, 0, 0]));
  await writeFile(join(cwd, "image.png"), bytes);
  await writeFile(
    join(cwd, "input.md"),
    "Original captured text.\n\n![diagram](image.png)",
  );
  await invoke(
    registerFor(cwd, { PI_KS_V2_HEADLESS_GRANTS: "import" }),
    "ks_v2_import",
    { collection: "demo", path: "input.md" },
    context(cwd),
  );
  const kb = new KnowledgeRuntime(
    join(cwd, ".pi", "knowledge-studio", "collections", "demo"),
  );
  const documentId = (await kb.list())[0]!.id;
  const result = await invoke(
    registerFor(cwd, { PI_KS_V2_HEADLESS_GRANTS: "search" }),
    "ks_v2_document",
    { collection: "demo", documentId },
    context(cwd),
  );
  const content = result.content[0]!;
  assert.equal(content.type, "text");
  if (content.type !== "text") throw new Error("Expected metadata");
  const document = JSON.parse(content.text);
  assert.equal(document.images.length, 1);
  assert.ok(document.images[0].locator);
  assert.doesNotMatch(content.text, /\.pi|\/blobs\/|sourcePath/);
  return {
    kb,
    bytes,
    document,
    params: {
      collection: "demo",
      documentId,
      imageId: document.images[0].id,
      prompt: "Describe the diagram",
    },
  };
}
const enrichmentEnv = {
  ...modelEnv,
  PI_KS_V2_VISION_REVISION: "fixture-revision-1",
};

test("enrichment requires two distinct approvals and explicit host revision without egress", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ks-v2-enrich-deny-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { kb, params } = await enrichmentFixture(cwd);
  const network = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected network");
  });
  for (const grants of ["", "enrich", "vision"]) {
    await assert.rejects(
      invoke(
        registerFor(cwd, { ...enrichmentEnv, PI_KS_V2_HEADLESS_GRANTS: grants }),
        "ks_v2_enrich_image",
        params,
        context(cwd),
      ),
      grants === "vision" ? /enrich denied/ : /vision denied/,
    );
  }
  for (const denied of ["vision", "enrich"]) {
    const approvals: string[] = [];
    await assert.rejects(
      invoke(
        registerFor(cwd, enrichmentEnv),
        "ks_v2_enrich_image",
        params,
        context(cwd, async (title) => {
          approvals.push(title.split(": ")[1]!);
          return !title.endsWith(denied);
        }),
      ),
      new RegExp(`${denied} denied`),
    );
    assert.deepEqual(
      approvals,
      denied === "vision" ? ["vision"] : ["vision", "enrich"],
    );
  }
  for (const revision of [undefined, "", " "]) {
    await assert.rejects(
      invoke(
        registerFor(cwd, {
          ...modelEnv,
          ...(revision === undefined
            ? {}
            : { PI_KS_V2_VISION_REVISION: revision }),
          PI_KS_V2_HEADLESS_GRANTS: "vision,enrich",
        }),
        "ks_v2_enrich_image",
        params,
        context(cwd, async () => {
          assert.fail("revision must precede approval");
        }),
      ),
      /PI_KS_V2_VISION_REVISION/,
    );
  }
  assert.equal(network.mock.callCount(), 0);
  await assert.rejects(kb.search("quasarwidget"), /No relevant evidence found/);
});

test("approved enrichment previews exact identity and retrieves original text via hint only", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ks-v2-enrich-success-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { bytes, document, params } = await enrichmentFixture(cwd);
  const approvals: string[] = [];
  const tools = registerFor(cwd, {
    ...enrichmentEnv,
    PI_KS_V2_VISION_API_KEY: "secret-fixture",
  });
  const network = t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, init?: RequestInit) => {
      assert.deepEqual(approvals, ["vision", "enrich"]);
      assert.equal(String(url), modelEnv.PI_KS_V2_VISION_ENDPOINT);
      const request = JSON.parse(String(init?.body));
      assert.equal(request.model, modelEnv.PI_KS_V2_VISION_MODEL);
      assert.equal(request.messages[1].content[0].text, params.prompt);
      assert.equal(
        request.messages[1].content[1].image_url.url,
        `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
      );
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "quasarwidget synthetic hint",
            },
          },
        ],
      });
    },
  );
  const result = await invoke(
    tools,
    "ks_v2_enrich_image",
    params,
    context(cwd, async (title, message) => {
      approvals.push(title.split(": ")[1]!);
      const preview = JSON.parse(message.slice(message.indexOf("\n") + 1));
      assert.equal(preview.documentRevision, document.revision);
      assert.equal(preview.imageHash, document.images[0].blobHash);
      assert.equal(preview.sizeBytes, bytes.length);
      assert.equal(preview.documentId, params.documentId);
      assert.equal(preview.imageId, params.imageId);
      assert.equal(preview.hostEndpoint, modelEnv.PI_KS_V2_VISION_ENDPOINT);
      assert.equal(preview.model, modelEnv.PI_KS_V2_VISION_MODEL);
      assert.equal(
        preview.modelRevision,
        enrichmentEnv.PI_KS_V2_VISION_REVISION,
      );
      assert.equal(preview.prompt, params.prompt);
      assert.doesNotMatch(message, /secret-fixture/);
      return true;
    }),
  );
  assert.equal(network.mock.callCount(), 1);
  assert.match(JSON.stringify(result), /retrieval-only/);
  assert.match(JSON.stringify(result), /never source quotation/);
  const search = await invoke(
    registerFor(cwd, { PI_KS_V2_HEADLESS_GRANTS: "search" }),
    "ks_v2_search",
    { collection: "demo", query: "quasarwidget" },
    context(cwd),
  );
  assert.match(JSON.stringify(search), /Original captured text/);
  assert.doesNotMatch(JSON.stringify(search), /quasarwidget synthetic hint/);
});

test("mutation during either enrichment approval rejects stale preview before model call", async (t) => {
  const network = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected network");
  });
  for (const mutateAt of ["vision", "enrich"]) {
    const cwd = await mkdtemp(join(tmpdir(), "ks-v2-enrich-stale-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const { kb, params } = await enrichmentFixture(cwd);
    await assert.rejects(
      invoke(
        registerFor(cwd, enrichmentEnv),
        "ks_v2_enrich_image",
        params,
        context(cwd, async (title) => {
          if (title.endsWith(mutateAt)) {
            await writeFile(
              join(cwd, "input.md"),
              "Changed original text.\n\n![diagram](image.png)",
            );
            await kb.ingest(cwd, join(cwd, "input.md"));
          }
          return true;
        }),
      ),
      /Sources changed during enrichment approvals/,
    );
  }
  assert.equal(network.mock.callCount(), 0);
});

const rerankEnv = {
  PI_KS_V2_RERANK_ENDPOINT: "http://127.0.0.1:9876/rerank",
  PI_KS_V2_RERANK_MODEL: "rerank-fixture",
  PI_KS_V2_RERANK_REVISION: "revision-1",
  PI_KS_V2_RERANK_API_KEY: "rerank-secret-fixture",
};
const retrievalTools = ["search", "generate", "export"] as const;
const rerankParams = {
  collection: "demo",
  query: "Hello",
  limit: 1,
  title: "Report",
  output: "report",
  rerank: true,
};

test("rerank configuration and distinct consent fail closed for all retrieval tools", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ks-v2-rerank-deny-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const network = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected network");
  });
  for (const name of retrievalTools) {
    for (const key of ["ENDPOINT", "MODEL", "REVISION"]) {
      await assert.rejects(
        invoke(
          registerFor(cwd, {
            ...modelEnv,
            ...rerankEnv,
            [`PI_KS_V2_RERANK_${key}`]: "",
          }),
          `ks_v2_${name}`,
          rerankParams,
          context(cwd, async () => true),
        ),
        /PI_KS_V2_RERANK_/,
      );
    }
    for (const endpoint of [
      "file:///tmp/rerank",
      "http://example.com/rerank",
      "https://user:pass@example.com",
      "https://example.com/?key=secret",
      "https://example.com/#secret",
    ]) {
      await assert.rejects(
        invoke(
          registerFor(cwd, {
            ...modelEnv,
            ...rerankEnv,
            PI_KS_V2_RERANK_ENDPOINT: endpoint,
          }),
          `ks_v2_${name}`,
          rerankParams,
          context(cwd, async () => true),
        ),
        /Invalid reranker endpoint/,
      );
    }
    for (const timeout of ["", "01", "1e3", " 1", "0", "180001"]) {
      await assert.rejects(
        invoke(
          registerFor(cwd, {
            ...modelEnv,
            ...rerankEnv,
            PI_KS_V2_RERANK_TIMEOUT_MS: timeout,
          }),
          `ks_v2_${name}`,
          rerankParams,
          context(cwd, async () => true),
        ),
        /strict integer/,
      );
    }
    const tools = registerFor(cwd, {
      ...modelEnv,
      ...rerankEnv,
      PI_KS_V2_HEADLESS_GRANTS: "search,generate,export,embedding",
    });
    await assert.rejects(
      invoke(tools, `ks_v2_${name}`, rerankParams, context(cwd)),
      /rerank denied/,
    );
    await assert.rejects(
      invoke(
        tools,
        `ks_v2_${name}`,
        rerankParams,
        context(cwd, async (title) => !title.endsWith("rerank")),
      ),
      /rerank denied/,
    );
  }
  assert.equal(network.mock.callCount(), 0);
  assert.deepEqual(await readdir(cwd), []);
});

test("default and explicit false never call reranker or require rerank config", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ks-v2-rerank-default-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const tools = registerFor(cwd, {
    ...modelEnv,
    PI_KS_V2_HEADLESS_GRANTS: "import,search,export",
  });
  await writeFile(join(cwd, "input.txt"), "Hello evidence");
  await invoke(
    tools,
    "ks_v2_import",
    { collection: "demo", path: "input.txt" },
    context(cwd),
  );
  const network = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected network");
  });
  for (const rerank of [undefined, false]) {
    for (const name of ["search", "export"]) {
      await invoke(
        tools,
        `ks_v2_${name}`,
        { ...rerankParams, rerank },
        context(cwd),
      );
    }
    await assert.rejects(
      invoke(
        tools,
        "ks_v2_generate",
        { ...rerankParams, rerank },
        context(cwd),
      ),
      /generate denied/,
    );
  }
  assert.equal(network.mock.callCount(), 0);
});

test("approved local rerank sends query and 30 originals, preserves authority across search/generate/export", async (t) => {
  const { createServer } = await import("node:http");
  const cwd = await mkdtemp(join(tmpdir(), "ks-v2-rerank-local-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const requests: Array<{
    query: string;
    documents: string[];
    model: string;
    top_n: number;
    return_documents: boolean;
  }> = [];
  let malicious = false;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(request);
    assert.equal(req.headers.authorization, "Bearer rerank-secret-fixture");
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        results: request.documents.map((_text: string, index: number) => ({
          index: malicious ? 0 : index,
          relevance_score: index,
          document: { text: "ATTACK replacement source" },
          id: "ATTACK",
          sourceId: "ATTACK",
        })),
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/rerank`;
  const env = { ...modelEnv, ...rerankEnv, PI_KS_V2_RERANK_ENDPOINT: endpoint };
  const tools = registerFor(cwd, env);
  const approvals: string[] = [];
  const ctx = context(cwd, async (title, message) => {
    approvals.push(title.split(": ")[1]!);
    assert.doesNotMatch(message, /rerank-secret-fixture/);
    if (title.endsWith("rerank")) {
      assert.match(message, /up to 30 ORIGINAL candidate texts/);
      assert.match(message, /NOT present in returned hits/);
      assert.match(message, /Hello/);
      const identity = JSON.parse(message.slice(message.indexOf("\n") + 1));
      assert.equal(identity.endpoint, endpoint);
      assert.equal(identity.model, env.PI_KS_V2_RERANK_MODEL);
      assert.equal(identity.revision, env.PI_KS_V2_RERANK_REVISION);
      assert.equal(identity.apiKey, undefined);
    }
    return true;
  });
  for (let i = 0; i < 35; i++) {
    await writeFile(
      join(cwd, `input-${i}.txt`),
      `Hello original candidate ${i}`,
    );
    await invoke(
      tools,
      "ks_v2_import",
      { collection: "demo", path: `input-${i}.txt` },
      ctx,
    );
  }
  approvals.length = 0;
  const result = await invoke(tools, "ks_v2_search", rerankParams, ctx);
  assert.deepEqual(approvals, ["search", "rerank"]);
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.query, "Hello");
  assert.equal(request.documents.length, 30);
  assert.equal(request.top_n, 30);
  assert.equal(request.return_documents, false);
  assert.equal(request.model, "rerank-fixture");
  assert.ok(
    request.documents.every((text) =>
      /^Hello original candidate \d+$/.test(text),
    ),
  );
  const content = result.content[0]!;
  assert.equal(content.type, "text");
  if (content.type !== "text") throw new Error("Expected text");
  const { bundle } = JSON.parse(content.text);
  assert.equal(bundle.texts.length, 1);
  assert.equal(bundle.texts[0].text, request.documents[29]);
  assert.match(bundle.sources[0].id, /^doc_/);
  assert.doesNotMatch(content.text, /ATTACK|rerank-secret-fixture/);
  await invoke(tools, "ks_v2_export", rerankParams, ctx);
  // Generation has its own subsequent gate; rerank consent never authorizes generation.
  await assert.rejects(
    invoke(
      tools,
      "ks_v2_generate",
      rerankParams,
      context(cwd, async (title) => !title.endsWith("generate")),
    ),
    /generate denied/,
  );
  assert.equal(requests.length, 3);
  malicious = true;
  for (const name of retrievalTools) {
    await assert.rejects(
      invoke(tools, `ks_v2_${name}`, rerankParams, ctx),
      /Invalid rerank index or score/,
    );
  }
  // Public fingerprints are invariant under credentials; no credential-derived hash in UI.
  const { HttpReranker } = await import(
    "../src/adapters/models/http-reranker.ts"
  );
  const identity = (apiKey: string) =>
    new HttpReranker({
      endpoint,
      model: "rerank-fixture",
      revision: "revision-1",
      approved: true,
      apiKey,
    }).identity;
  assert.deepEqual(identity("secret-one"), identity("secret-two"));
});

test("HTML import default deny, structural disclosure, shared resource preflight and offline capture", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ks-v2-html-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const tools = registerFor(cwd),
    params = { collection: "demo", path: "input.html" };
  await writeFile(
    join(cwd, "input.html"),
    '<p>HTML fixture<img src="image.png"></p>',
  );
  await writeFile(
    join(cwd, "image.png"),
    encodePng(1, 1, 3, Buffer.from([1, 2, 3])),
  );
  await assert.rejects(
    invoke(tools, "ks_v2_import", params, context(cwd)),
    /import denied/,
  );
  const network = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected network");
  });
  const result = await invoke(
    tools,
    "ks_v2_import",
    params,
    context(cwd, async (_title, message) => {
      assert.match(message, /HTML structural text/);
      assert.match(message, /Python 3 required/);
      assert.match(message, /Not browser visibility/);
      return true;
    }),
  );
  assert.match(JSON.stringify(result), /HTML_CAPTURE_LIMITATIONS/);
  assert.equal(network.mock.callCount(), 0);
  for (const src of [
    "%2ehidden.png",
    "private-key.png",
    "../image.png",
    "https://example.org/image.png",
  ]) {
    await writeFile(join(cwd, "input.html"), `<img src="${src}">`);
    await assert.rejects(
      invoke(
        tools,
        "ks_v2_import",
        params,
        context(cwd, async () => true),
      ),
      /excludes|relative local|Unsafe/,
    );
  }
});

test("HTML changed after preflight still enforces source policy before publishing", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ks-v2-html-policy-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const path = join(cwd, "input.html");
  await writeFile(path, "<p>safe</p>");
  await writeFile(
    join(cwd, "private-key.png"),
    encodePng(1, 1, 3, Buffer.from([1, 2, 3])),
  );
  const { SqliteCatalog } = await import(
    "../src/adapters/storage/sqlite-catalog.ts"
  );
  const use = SqliteCatalog.use;
  let changed = false;
  t.mock.method(
    SqliteCatalog,
    "use",
    async (...args: Parameters<typeof use>) => {
      if (!changed) {
        changed = true;
        await writeFile(path, '<p>changed<img src="private-key.png"></p>');
      }
      return use(...args);
    },
  );
  await assert.rejects(
    invoke(
      registerFor(cwd, { PI_KS_V2_HEADLESS_GRANTS: "import" }),
      "ks_v2_import",
      { collection: "demo", path: "input.html" },
      context(cwd),
    ),
    /excludes/,
  );
  assert.equal(changed, true);
});

 test("durable PDF tools direct input parse only, deny egress, status and incomplete exclusion", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pdf-tool-"));
  try {
    const { fixture } = await import("./pdf-job-fixture.ts");
    await writeFile(join(cwd, "book.pdf"), fixture(["local synthetic book"]));
    const tools = registerFor(cwd, { PI_KS_V2_HEADLESS_GRANTS: "import,list,search" });
    const result = await invoke(tools, "ks_v2_pdf_start", { path: "book.pdf" }, context(cwd));
    const text = result.content.find(c => c.type === "text"); assert.ok(text?.type === "text");
    const m = JSON.parse(text.text); assert.equal(m.state, "parsed"); assert.equal(m.space, null);
    assert.ok((await readdir(join(cwd, ".pi", "knowledge-studio"))).includes("pdf-jobs"));
    assert.ok(!(await readdir(join(cwd, ".pi"))).includes("knowledge-studio-v2-pdf-jobs"));
    await invoke(tools, "ks_v2_pdf_status", { bookId: m.bookId }, context(cwd));
    await assert.rejects(invoke(tools, "ks_v2_pdf_search", { bookId: m.bookId, query: "synthetic" }, context(cwd)), /incomplete/);
    await assert.rejects(invoke(tools, "ks_v2_pdf_resume", { bookId: m.bookId, index: true }, context(cwd)), /index denied/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("PDF profile tools persist revisions and egress denial leaves shadow paused", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ks-profile-tools-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected egress"); });
  const tools = registerFor(cwd);
  const approved = context(cwd, async () => true);
  const profile = { id: "local", endpoint: "http://127.0.0.1:7777/embeddings", kind: "openai", space: { provider: "fixture", model: "synthetic", revision: "1", dimension: 2, queryInstruction: "", documentInstruction: "" }, credentialEnv: null };
  await invoke(tools, "ks_v2_profile_add", profile, approved);
  await invoke(tools, "ks_v2_profile_select", { id: "local", revision: 1 }, approved);
  const { PdfJobs } = await import("../src/application/pdf-jobs.ts");
  const { PdfGenerations } = await import("../src/application/pdf-generation-store.ts");
  const { fixture } = await import("./pdf-job-fixture.ts");
  await writeFile(join(cwd, "source.pdf"), fixture(["synthetic evidence"], true));
  const old = new PdfJobs(join(cwd, "legacy")); const m = await old.start(cwd, join(cwd, "source.pdf")); await old.resume(m.bookId);
  await invoke(tools, "ks_v2_pdf_migrate", { legacyRoot: "legacy", bookId: m.bookId }, approved);
  await invoke(tools, "ks_v2_pdf_reindex", { bookId: m.bookId }, approved);
  const store = new PdfGenerations(join(cwd, ".pi", "knowledge-studio", "pdf-generations"));
  const g = (await store.status(m.bookId)).generations[0]!;
  await assert.rejects(invoke(tools, "ks_v2_pdf_generation_resume", { generationId: g.id }, context(cwd, async (_title, message) => !message.includes("Send PDF text"))));
  assert.equal((await store.generationSnapshot(g.id)).state, "paused");
  await invoke(tools, "ks_v2_pdf_generation_cancel", { generationId: g.id }, approved);
  assert.equal((await store.generationSnapshot(g.id)).state, "cancelled");
  assert.equal(network.mock.callCount(), 0);
});

test("legacy hybrid tool requires separate association and redacts host transport errors", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ks-legacy-hybrid-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  const { PdfJobs } = await import("../src/application/pdf-jobs.ts");
  const { PdfGenerations, profileSpace } = await import("../src/application/pdf-generation-store.ts");
  const { fixture } = await import("./pdf-job-fixture.ts");
  const profile = { id: "local", revision: 1, endpoint: "http://127.0.0.1:7777/embeddings", kind: "openai" as const, space: { provider: "fixture", model: "synthetic", revision: "1", dimension: 2, queryInstruction: "", documentInstruction: "" }, credentialEnv: "PI_KS_PROFILE_SYNTHETIC" };
  const tools = registerFor(cwd, { PI_KS_PROFILE_SYNTHETIC: "secret-marker\ntrailing" }), approved = context(cwd, async () => true);
  const { revision: _revision, ...input } = profile; await invoke(tools, "ks_v2_profile_add", input, approved);
  await writeFile(join(cwd, "source.pdf"), fixture(["synthetic evidence"], true));
  const old = new PdfJobs(join(cwd, "legacy")), m = await old.start(cwd, join(cwd, "source.pdf"));
  await old.resume(m.bookId, { provider: { space: profileSpace(profile), async embed(texts) { return texts.map(() => [1, 2]); } } });
  await invoke(tools, "ks_v2_pdf_migrate", { legacyRoot: "legacy", bookId: m.bookId }, approved);
  const store = new PdfGenerations(join(cwd, ".pi", "knowledge-studio", "pdf-generations")), a = (await store.status(m.bookId)).book.active!;
  const query = { bookId: m.bookId, query: "synthetic", mode: "hybrid" };
  await assert.rejects(invoke(tools, "ks_v2_pdf_generation_search", query, approved), /no credential profile/);
  const association = { generationId: a, profileId: "local", profileRevision: 1 };
  await assert.rejects(invoke(tools, "ks_v2_pdf_generation_associate", association, context(cwd, async () => false)));
  assert.equal((await store.generationSnapshot(a)).profile, null);
  await invoke(tools, "ks_v2_pdf_generation_associate", association, approved);
  const network = t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => { new Request(url, init); return new Response(JSON.stringify({ model: "synthetic", data: [{ index: 0, embedding: [1, 2] }] })); });
  await assert.rejects(invoke(tools, "ks_v2_pdf_generation_search", query, approved), (error: unknown) => { assert.ok(error instanceof Error); assert.ok(!String(error.stack).includes("secret-marker")); assert.equal(error.cause, undefined); return true; });
  assert.equal(network.mock.callCount(), 0);
  const good = registerFor(cwd, { PI_KS_PROFILE_SYNTHETIC: "synthetic-valid" });
  await invoke(good, "ks_v2_pdf_generation_search", query, approved); assert.equal(network.mock.callCount(), 1);
  network.mock.mockImplementation(async () => { throw new Error("secret-marker", { cause: new Error("secret-marker") }); });
  await assert.rejects(invoke(good, "ks_v2_pdf_generation_search", query, approved), (error: unknown) => { assert.ok(error instanceof Error); assert.equal(error.message, "Profile embedding request failed"); assert.equal(error.cause, undefined); return true; });
});


test("legacy root blocks extension storage without creating a replacement", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ks-old-layout-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".pi", "knowledge-studio-v2"), { recursive: true, mode: 0o700 });
  await assert.rejects(invoke(registerFor(cwd, { PI_KS_V2_HEADLESS_GRANTS: "list" }), "ks_v2_list", { collection: "demo" }, context(cwd)), /Legacy Studio storage detected/);
  assert.deepEqual(await readdir(join(cwd, ".pi")), ["knowledge-studio-v2"]);
});

test("all new Studio children are excluded as source input", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ks-layout-source-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const tools = registerFor(cwd, { PI_KS_V2_HEADLESS_GRANTS: "import" });
  for (const child of ["collections", "pdf-jobs", "pdf-generations", "exports", "legacy-v1"]) {
    await assert.rejects(invoke(tools, "ks_v2_import", { collection: "demo", path: `.pi/knowledge-studio/${child}/source.md` }, context(cwd)), /excludes/);
  }
  assert.deepEqual(await readdir(cwd), []);
});

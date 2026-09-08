import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import v2 from "../extensions/v2.ts";
import { encodePng } from "../src/adapters/export/encode-png.ts";
import { KnowledgeRuntime } from "../src/application/knowledge-runtime.ts";
import { SqliteCatalog } from "../src/adapters/storage/sqlite-catalog.ts";
import { buildAnswerContext } from "../src/application/answer-context.ts";

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

const params = { collection: "demo", query: "Hello", title: "Different display title", output: "report" };
async function fixture(t: test.TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "answer-extension-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const tools = registerFor(cwd, modelEnv);
  await writeFile(join(cwd, "image.png"), encodePng(1, 1, 3, Buffer.from([1, 2, 3])));
  await writeFile(join(cwd, "input.md"), "Hello evidence.\n\n![captured caption](image.png)");
  await invoke(tools, "ks_v2_import", { collection: "demo", path: "input.md" }, context(cwd, async () => true));
  const kb = new KnowledgeRuntime(join(cwd, ".pi", "knowledge-studio", "collections", "demo"));
  return { cwd, tools, kb };
}
function wire(bundle: { texts: { id: string }[] }, insufficient = false) {
  return { wireVersion: "grounded-answer-v2", status: insufficient ? "insufficient-evidence" : "answered", requirements: [{ id: "r1", requirement: "Hello", status: insufficient ? "missing" : "supported", evidenceIds: insufficient ? [] : [bundle.texts[0]!.id] }], figures: [], paragraphs: insufficient ? [] : [{ text: "Hello evidence.", evidenceIds: [bundle.texts[0]!.id], requirementIds: ["r1"] }] };
}
function response(value: unknown) {
  return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(value) } }] });
}

test("registered generation sends exact disclosed question/bundle/host links and exports new answered protocol", async t => {
  const { cwd, tools } = await fixture(t);
  let disclosed: unknown;
  const approvals: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(request).sort(), ["messages", "model", "response_format"]);
    assert.equal(request.response_format.json_schema.name, "grounded_answer_v2");
    const input = JSON.parse(request.messages[1].content);
    assert.deepEqual(disclosed, input);
    assert.equal(input.question, params.query);
    assert.equal(input.title, params.title);
    assert.equal(input.figurePolicy, "selective");
    assert.equal(input.hostDerivedFigureCandidates[0].caption, "captured caption");
    assert.deepEqual(input.hostDerivedFigureCandidates[0].linkedTextIds, [input.bundle.texts[0].id]);
    return response(wire(input.bundle));
  });
  const result = await invoke(tools, "ks_v2_generate", { ...params, hostDerivedFigureCandidates: [{ caption: "ATTACK" }] }, context(cwd, async (title, message) => {
    approvals.push(title.split(": ")[1]!);
    if (title.endsWith("generate")) disclosed = JSON.parse(message.slice(message.indexOf("\n") + 1));
    return true;
  }));
  assert.equal((result.details as Record<string, unknown>).status, "answered");
  assert.equal((result.details as Record<string, unknown>).generatedByModel, true);
  assert.equal((result.details as Record<string, unknown>).semanticProof, false);
  assert.deepEqual(approvals, ["search", "generate", "export"]);
  assert.equal((await readdir(join(cwd, ".pi", "knowledge-studio", "exports", "report"))).length, 1);
});

test("insufficient model judgment and exact empty retrieval return assessment without export or output writes", async t => {
  const { cwd, tools } = await fixture(t);
  const network = t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => response(wire(JSON.parse(JSON.parse(String(init?.body)).messages[1].content).bundle, true)));
  const approvals: string[] = [];
  const ctx = context(cwd, async title => { approvals.push(title.split(": ")[1]!); return true; });
  for (const query of ["Hello", "zzzzabsentzzzz"]) {
    const result = await invoke(tools, "ks_v2_generate", { ...params, query }, ctx);
    assert.equal((result.details as Record<string, unknown>).status, "insufficient-evidence");
    assert.equal((result.details as Record<string, unknown>).document, null);
    assert.match(String((result.details as Record<string, unknown>).notice), /limited to retrieved evidence/);
    assert.equal((result.details as Record<string, unknown>).path, undefined);
  }
  assert.equal(network.mock.callCount(), 1);
  assert.deepEqual(approvals, ["search", "generate", "search"]);
  assert.ok(!(await readdir(join(cwd, ".pi", "knowledge-studio"))).includes("exports"));
  for (const message of ["database failed", "timeout", "No relevant evidence found: timeout"]) {
    const mocked = t.mock.method(KnowledgeRuntime.prototype, "search", async () => { throw new Error(message); });
    await assert.rejects(invoke(tools, "ks_v2_generate", params, ctx), { message });
    mocked.mock.restore();
  }
});

test("denials and epoch changes gate new generation and export", async t => {
  for (const stage of ["deny-search", "deny-generate", "deny-export", "epoch-generate", "epoch-response", "epoch-export"]) {
    const { cwd, tools, kb } = await fixture(t);
    const remove = async () => { await kb.remove((await kb.list())[0]!.id); };
    const network = t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      if (stage === "epoch-response") await remove();
      return response(wire(input.bundle));
    });
    await assert.rejects(invoke(tools, "ks_v2_generate", params, context(cwd, async title => {
      if (stage === `epoch-${title.split(": ")[1]}`) await remove();
      return stage !== `deny-${title.split(": ")[1]}`;
    })), /denied|Sources changed during generation/);
    assert.equal(network.mock.callCount(), ["deny-search", "deny-generate", "epoch-generate"].includes(stage) ? 0 : 1);
    if ((await readdir(join(cwd, ".pi", "knowledge-studio"))).includes("exports"))
      assert.deepEqual(await readdir(join(cwd, ".pi", "knowledge-studio", "exports", "report")), []);
    network.mock.restore();
  }
});

test("catalog context rejects source/revision/text/occurrence tampering and uses captured adjacency", async t => {
  const { kb } = await fixture(t);
  const { bundle } = await kb.search("Hello");
  const snapshot = await SqliteCatalog.use(kb.root, async catalog => catalog.snapshot());
  assert.equal(buildAnswerContext(bundle, snapshot).length, 1);
  for (const mutate of [
    (b: typeof bundle) => { b.sources[0]!.revisionHash = "bad"; },
    (b: typeof bundle) => { b.texts[0]!.locator = { kind: "page", page: 99 }; },
    (b: typeof bundle) => { b.images[0]!.id = "other"; },
    (b: typeof bundle) => { b.images[0]!.sourceId = "other"; },
    (b: typeof bundle) => { b.images[0]!.locator = { kind: "page", page: 99 }; },
  ]) {
    const changed = structuredClone(bundle); mutate(changed);
    assert.throws(() => buildAnswerContext(changed, snapshot), /mismatch|does not match/);
  }
  snapshot.documents[0]!.images[0]!.elementIds = [];
  assert.deepEqual(buildAnswerContext(bundle, snapshot), []);
});

test("none and required policies reach the new protocol; unsupported required figures abstain", async t => {
  const { cwd, tools } = await fixture(t);
  let policy = "none";
  const network = t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    const input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    assert.equal(input.figurePolicy, policy);
    const value = wire(input.bundle);
    if (policy === "required") { value.status = "insufficient-evidence"; value.paragraphs = []; }
    return response(value);
  });
  const ctx = context(cwd, async () => true);
  assert.equal((await invoke(tools, "ks_v2_generate", { ...params, figurePolicy: policy }, ctx)).details !== undefined, true);
  policy = "required";
  const result = await invoke(tools, "ks_v2_generate", { ...params, figurePolicy: policy, output: "unused" }, ctx);
  assert.equal((result.details as Record<string, unknown>).status, "insufficient-evidence");
  assert.deepEqual((result.details as Record<string, unknown>).reasons, ["required-figure-missing"]);
  assert.deepEqual(await readdir(join(cwd, ".pi", "knowledge-studio", "exports")), ["report"]);
  assert.equal(network.mock.callCount(), 2);
});

const controlEnv = {
  PI_KS_V2_GENERATE_PROTOCOL: "llama.cpp",
  PI_KS_V2_GENERATE_MAX_TOKENS: "2048",
  PI_KS_V2_GENERATE_ENABLE_THINKING: "false",
  PI_KS_V2_GENERATE_REASONING_BUDGET_TOKENS: "0",
};
test("host controls are snapshotted, disclosed without secrets, never overridden by tool args, and require consent", async t => {
  const { cwd } = await fixture(t);
  const tools = registerFor(cwd, { ...modelEnv, ...controlEnv, PI_KS_V2_GENERATE_API_KEY: "secret-fixture-key" });
  const network = t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(request).sort(), ["chat_template_kwargs", "max_tokens", "messages", "model", "reasoning_budget_tokens", "response_format"]);
    assert.equal(request.max_tokens, 2048);
    assert.deepEqual(request.chat_template_kwargs, { enable_thinking: false });
    assert.equal(request.reasoning_budget_tokens, 0);
    return response(wire(JSON.parse(request.messages[1].content).bundle, true));
  });
  const attack = { ...params, generation: { protocol: "other", maxTokens: 1 }, max_tokens: 1, enableThinking: true };
  let disclosures = 0;
  for (const allow of [false, true]) {
    const pending = invoke(tools, "ks_v2_generate", attack, context(cwd, async (title, message) => {
      assert.doesNotMatch(message, /secret-fixture-key/);
      if (title.endsWith("generate")) {
        disclosures++;
        assert.match(message, /Generation profile\/controls: \{"protocol":"llama.cpp","maxTokens":2048,"enableThinking":false,"reasoningBudgetTokens":0\}/);
        return allow;
      }
      return true;
    }));
    if (allow) await pending; else await assert.rejects(pending, /denied/);
    assert.equal(network.mock.callCount(), allow ? 1 : 0);
  }
  assert.equal(disclosures, 2);
  const properties = (tools.get("ks_v2_generate")!.parameters as unknown as { properties: Record<string, unknown> }).properties;
  for (const key of ["generation", "protocol", "maxTokens", "enableThinking", "reasoningBudgetTokens"]) assert.equal(properties[key], undefined);
});

test("malformed, orphaned and unsupported host controls reject before any retrieval approval or egress", async t => {
  const { cwd } = await fixture(t);
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected egress"); });
  const invalid: Record<string, string>[] = [
    { PI_KS_V2_GENERATE_PROTOCOL: "" }, { PI_KS_V2_GENERATE_PROTOCOL: "openai" },
    { PI_KS_V2_GENERATE_MAX_TOKENS: "2048" }, { PI_KS_V2_GENERATE_ENABLE_THINKING: "false" }, { PI_KS_V2_GENERATE_REASONING_BUDGET_TOKENS: "0" },
    { ...controlEnv, PI_KS_V2_GENERATE_REASONING_EFFORT: "none" },
    ...["", " 1", "01", "+1", "1.0", "1e3", "-1", "0", "32769", "NaN", "Infinity"].map(value => ({ ...controlEnv, PI_KS_V2_GENERATE_MAX_TOKENS: value })),
    ...["", "False", "TRUE", "0", " false"].map(value => ({ ...controlEnv, PI_KS_V2_GENERATE_ENABLE_THINKING: value })),
    ...["", "-1", "00", "0.0", "32769", "Infinity"].map(value => ({ ...controlEnv, PI_KS_V2_GENERATE_REASONING_BUDGET_TOKENS: value })),
  ];
  for (const env of invalid) {
    const tools = registerFor(cwd, { ...modelEnv, ...env });
    await assert.rejects(invoke(tools, "ks_v2_generate", { ...params, mode: "hybrid", rerank: true }, context(cwd, async () => { throw new Error("unexpected approval"); })), /generation/);
  }
  assert.equal(network.mock.callCount(), 0);
});

test("generation controls do not affect vision even when generation configuration is invalid", async t => {
  const { cwd } = await fixture(t);
  const requests: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Synthetic description" } }] });
  });
  for (const env of [{}, controlEnv, { PI_KS_V2_GENERATE_PROTOCOL: "unsupported" }]) {
    await invoke(registerFor(cwd, { ...modelEnv, ...env }), "ks_v2_describe_image", { path: "image.png", prompt: "Describe" }, context(cwd, async () => true));
  }
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(requests[2], requests[0]);
  assert.deepEqual(Object.keys(requests[0] as object).sort(), ["messages", "model"]);
});

#!/usr/bin/env node
/** Real Pi RPC acceptance. Only the loopback model transport is deterministic.
 * No ExtensionAPI mock, direct tool invocation, or installed-package patch. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { answerGenerationFromEnv, answerGenerationPayload } from "../src/adapters/models/answer-model-options.ts";
import { ANSWER_WIRE_VERSION } from "../src/domain/answer.ts";

const generationControlKeys = [
  "PI_KS_V2_GENERATE_PROTOCOL",
  "PI_KS_V2_GENERATE_MAX_TOKENS",
  "PI_KS_V2_GENERATE_ENABLE_THINKING",
  "PI_KS_V2_GENERATE_REASONING_BUDGET_TOKENS",
];

/** Validate before creating listeners, spawning Pi, or making any live request. */
export function generationHostSettings(host = process.env) {
  const generation = answerGenerationFromEnv(host);
  const rawTimeout = host.PI_KS_V2_GENERATE_TIMEOUT_MS ?? "120000";
  const timeoutMs = Number(rawTimeout);
  assert.ok(/^[1-9][0-9]*$/.test(rawTimeout) && Number.isInteger(timeoutMs) &&
    timeoutMs >= 1000 && timeoutMs <= 180000,
    "PI_KS_V2_GENERATE_TIMEOUT_MS must be an integer from 1000 to 180000");
  const env = Object.fromEntries(generationControlKeys
    .filter((key) => host[key] !== undefined).map((key) => [key, host[key]]));
  return { env, timeoutMs, profile: generation ?? null, payload: answerGenerationPayload(generation) };
}

async function qwenObservation() {
  const read = async (path) => {
    const response = await fetch(`http://127.0.0.1:18082${path}`, { signal: AbortSignal.timeout(5000) });
    assert.ok(response.ok, `Qwen ${path} HTTP ${response.status}`);
    return response.json();
  };
  return { observedAt: new Date().toISOString(), health: await read("/health"),
    models: await read("/v1/models"), slots: await read("/slots") };
}
function requireIdleQwen(observation) {
  assert.equal(observation.health.status, "ok");
  assert.ok(observation.models.data.some((model) => model.id === "qwen3.8-27b-q5"));
  assert.ok(Array.isArray(observation.slots) && observation.slots.length > 0);
  assert.ok(observation.slots.every((slot) => slot.is_processing === false), "Qwen slots must be idle");
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultCli =
  "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
const generationQuestion = "How does the synthetic semaphore wake a waiting task?";
const generationTitle = "Synthetic guide";
const generationFigurePolicy = "required";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function syntheticPng() {
  function chunk(name, bytes) {
    const out = Buffer.alloc(bytes.length + 12);
    out.writeUInt32BE(bytes.length);
    out.write(name, 4);
    bytes.copy(out, 8);
    let crc = 0xffffffff;
    for (const byte of out.subarray(4, -4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
    return out;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function transport(expectedGenerationPayload) {
  const counts = { agent: 0, embedding: 0, generation: 0 };
  const errors = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST");
      let raw = "";
      for await (const part of req) {
        raw += part;
        assert.ok(raw.length < 2_000_000);
      }
      const body = JSON.parse(raw);
      if (req.url === "/embed") {
        counts.embedding++;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            model_id: "synthetic-embedding",
            model_revision: "v1",
            dimension: 4,
            embeddings: body.texts.map(() => [1, 0, 0, 0]),
          }),
        );
      } else if (req.url === "/generate") {
        counts.generation++;
        const controls = Object.fromEntries(["max_tokens", "chat_template_kwargs", "reasoning_budget_tokens"]
          .filter((key) => Object.hasOwn(body, key)).map((key) => [key, body[key]]));
        assert.deepEqual(controls, expectedGenerationPayload);
        const { question, title, bundle, figurePolicy, hostDerivedFigureCandidates } = JSON.parse(body.messages[1].content);
        assert.equal(question, generationQuestion);
        assert.equal(title, generationTitle);
        assert.notEqual(question, title);
        assert.equal(figurePolicy, generationFigurePolicy);
        assert.equal(body.response_format.json_schema.name, "grounded_answer_v2");
        assert.equal(body.response_format.json_schema.strict, true);
        const schema = body.response_format.json_schema.schema;
        assert.deepEqual(schema.properties.wireVersion.enum, ["grounded-answer-v2"]);
        assert.equal(schema.properties.blocks, undefined);
        assert.deepEqual(Object.keys(schema.properties.paragraphs.items.properties), ["text", "evidenceIds", "requirementIds"]);
        for (const item of [schema, schema.properties.paragraphs.items, schema.properties.figures.items, schema.properties.requirements.items]) {
          assert.equal(item.additionalProperties, false);
          assert.deepEqual(item.required, Object.keys(item.properties));
        }
        assert.ok(bundle.texts.length && bundle.images.length);
        const candidate = hostDerivedFigureCandidates.find((candidate) =>
          candidate.linkedTextIds.includes(bundle.texts[0].id),
        );
        assert.ok(candidate, "Missing host-derived linkage to supported text");
        assert.ok(bundle.images.some((image) => image.id === candidate.occurrenceId));
        const evidenceIds = [bundle.texts[0].id];
        const document = {
          wireVersion: "grounded-answer-v2",
          status: "answered",
          requirements: [{ id: "r1", requirement: question, status: "supported", evidenceIds }],
          figures: [{
            occurrenceId: candidate.occurrenceId,
            requirementId: "r1",
            evidenceIds,
            justification: "Include the host-linked source illustration alongside the explanation of event-driven semaphore wakeup; pixels were not inspected.",
          }],
          paragraphs: [
            {
              text: bundle.texts[0].text,
              evidenceIds,
              requirementIds: ["r1"],
            },
          ],
        };
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: JSON.stringify(document),
                },
              },
            ],
          }),
        );
      } else {
        assert.equal(req.url, "/v1/chat/completions");
        counts.agent++;
        assert.equal(body.stream, true);
        const last = body.messages.at(-1);
        let delta, finish;
        if (last.role === "user") {
          const text =
            typeof last.content === "string"
              ? last.content
              : last.content.map((item) => item.text ?? "").join("");
          const { name, args } = JSON.parse(text);
          assert.ok(
            body.tools.some((tool) => tool.function.name === name),
            `Pi did not expose ${name}`,
          );
          assert.ok(
            body.tools.every((tool) => tool.function.name.startsWith("ks_v2_")),
            "Unexpected tool exposed",
          );
          delta = {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${counts.agent}`,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          };
          finish = "tool_calls";
        } else {
          assert.equal(last.role, "tool");
          delta = {
            role: "assistant",
            content: "Synthetic driver completed this tool round.",
          };
          finish = "stop";
        }
        res.setHeader("Content-Type", "text/event-stream");
        for (const [d, reason] of [
          [delta, null],
          [{}, finish],
        ]) {
          res.write(
            `data: ${JSON.stringify({ id: `chat_${counts.agent}`, object: "chat.completion.chunk", created: 1, model: "synthetic-driver", choices: [{ index: 0, delta: d, finish_reason: reason }] })}\n\n`,
          );
        }
        res.end("data: [DONE]\n\n");
      }
    } catch (error) {
      errors.push(String(error));
      res.statusCode = 500;
      res.end("Synthetic transport assertion failed");
    }
  });
  await new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", ok);
  });
  return {
    server,
    counts,
    errors,
    base: `http://127.0.0.1:${server.address().port}`,
  };
}

class Rpc {
  constructor(cli, cwd, env, record) {
    this.events = [];
    this.pending = null;
    this.stderr = "";
    this.record = record;
    this.timeoutMs = Number(env.PI_KS_V2_GENERATE_TIMEOUT_MS) + 40_000;
    this.child = spawn(
      process.execPath,
      [
        cli,
        "--mode",
        "rpc",
        "--no-session",
        "--offline",
        "--no-extensions",
        "-e",
        join(repo, "extensions/v2.ts"),
        "--no-context-files",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-builtin-tools",
        "--provider",
        "pi-e2e",
        "--model",
        "synthetic-driver",
        "--thinking",
        "off",
      ],
      { cwd, env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (data) => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        try {
          this.receive(JSON.parse(line));
        } catch (error) {
          this.fail(error);
        }
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (data) => {
      this.stderr += data;
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) =>
      this.fail(new Error(`Pi exit ${code}/${signal}: ${this.stderr}`)),
    );
  }
  fail(error) {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = null;
    }
  }
  send(value) {
    this.record({ direction: "in", ...value });
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  receive(event) {
    // Store authoritative results/confirmations, not token deltas or duplicated history.
    if (
      ![
        "message_update",
        "message_start",
        "message_end",
        "agent_end",
        "turn_end",
      ].includes(event.type)
    )
      this.record({ direction: "out", ...event });
    this.events.push(event);
    if (
      event.type === "extension_error" ||
      (event.type === "response" && !event.success)
    )
      throw new Error(JSON.stringify(event));
    if (event.type === "extension_ui_request" && event.method === "confirm") {
      assert.ok(
        this.pending,
        "Unexpected confirmation outside a requested operation",
      );
      const grant = event.title.replace("Knowledge Studio V2: ", "");
      assert.notEqual(grant, event.title, "Unexpected confirmation title");
      this.pending.confirmations.push(grant);
      this.send({
        type: "extension_ui_response",
        id: event.id,
        confirmed: this.pending.allow.includes(grant),
      });
    }
    if (event.type === "agent_settled" && this.pending) {
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      const events = this.events.slice(pending.start);
      const starts = events.filter(
        (item) => item.type === "tool_execution_start",
      );
      const ends = events.filter((item) => item.type === "tool_execution_end");
      try {
        assert.equal(starts.length, 1);
        assert.equal(ends.length, 1);
        assert.equal(starts[0].toolName, pending.name);
        assert.deepEqual(starts[0].args, pending.args);
        assert.equal(ends[0].toolCallId, starts[0].toolCallId);
        assert.equal(ends[0].isError, pending.denied, JSON.stringify(ends[0]));
        if (pending.denied)
          assert.match(JSON.stringify(ends[0].result), /denied/);
        pending.resolve({
          result: ends[0].result,
          confirmations: pending.confirmations,
        });
      } catch (error) {
        pending.reject(error);
      }
    }
  }
  call(name, args, allow, denied = false) {
    assert.equal(this.pending, null);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.fail(
            new Error(`Pi timeout for ${name}; stderr: ${this.stderr}`),
          ),
        this.timeoutMs,
      );
      this.pending = {
        name,
        args,
        allow,
        denied,
        resolve,
        reject,
        timer,
        start: this.events.length,
        confirmations: [],
      };
      this.send({ type: "prompt", message: JSON.stringify({ name, args }) });
    });
  }
  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => this.child.kill("SIGKILL"), 3000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      this.child.kill("SIGTERM");
    });
  }
}
const payload = (response) =>
  JSON.parse(response.result.content.find((item) => item.type === "text").text);
async function files(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else result.push(path);
  }
  return result;
}
async function snapshot(root) {
  const entries = [];
  for (const path of await files(root))
    entries.push([path.slice(root.length), digest(await readFile(path))]);
  return entries.sort((a, b) => a[0].localeCompare(b[0]));
}
async function verifyPackage(path, original) {
  const all = await files(path);
  assert.ok(all.some((file) => file.endsWith("/manifest.json")));
  const pngs = all.filter((file) => file.endsWith(".png"));
  assert.ok(pngs.length > 0);
  assert.ok(
    (await Promise.all(pngs.map((file) => readFile(file)))).some((bytes) =>
      bytes.equals(original),
    ),
  );
  const markdown = await readFile(join(path, "document.md"), "utf8");
  const html = await readFile(join(path, "document.html"), "utf8");
  const evidence = JSON.parse(
    await readFile(join(path, "evidence.json"), "utf8"),
  );
  const sources = JSON.parse(
    await readFile(join(path, "sources.json"), "utf8"),
  );
  const manifest = JSON.parse(
    await readFile(join(path, "manifest.json"), "utf8"),
  );
  assert.ok(
    evidence.excerpts.length &&
      sources.occurrences.length &&
      sources.sources.length,
  );
  assert.ok(
    sources.occurrences.some((image) => image.blobHash === digest(original)),
  );
  assert.match(markdown, /!\[/);
  assert.match(html, /<img/);
  for (const text of evidence.excerpts) {
    assert.equal(text.textHash, digest(text.text));
    assert.ok(sources.sources.some((source) => source.id === text.sourceId));
    assert.ok(markdown.includes(`[${text.id}]`), "Missing rendered citation");
  }
  for (const file of manifest.files) {
    assert.ok(!file.path.includes("..") && !file.path.startsWith("/"));
    const bytes = await readFile(join(path, file.path));
    assert.equal(digest(bytes), file.sha256);
    assert.equal(bytes.length, file.byteLength);
  }
  assert.match(markdown, /synthetic/i);
  return {
    originalSha256: digest(original),
    texts: evidence.excerpts.length,
    images: sources.occurrences.length,
    files: all.length,
  };
}

export async function runSmoke({
  cli = defaultCli,
  keep = false,
  live = false,
} = {}) {
  const hostSettings = generationHostSettings();
  const generationTimeoutMs = hostSettings.timeoutMs;
  const root = await mkdtemp(join(tmpdir(), "pi-e2e-"));
  const home = join(root, "home"),
    cwd = join(root, "work"),
    agent = join(home, ".pi", "agent");
  await mkdir(agent, { recursive: true, mode: 0o700 });
  await mkdir(cwd, { mode: 0o700 });
  const local = await transport(hostSettings.payload);
  const log = [];
  const record = (value) =>
    log.push(
      JSON.stringify({ recordedAt: new Date().toISOString(), ...value })
        .replaceAll(root, "<TEMP>")
        .replaceAll(repo, "<REPO>"),
    );
  const operations = [];
  const startedAt = Date.now();
  const counterScope = live
    ? "Loopback agent driver only; embedding/generation counters do NOT observe live requests or prove denied-egress absence"
    : "All deterministic loopback model requests";
  const observations = [];
  const runMetadata = {
    answerContract: ANSWER_WIRE_VERSION,
    hostProfile: hostSettings.profile,
    generationPayload: hostSettings.payload,
    generationTimeoutMs,
    startedAt: new Date(startedAt).toISOString(),
  };
  let rpc;
  try {
    const original = syntheticPng();
    await writeFile(join(cwd, "diagram.png"), original);
    await writeFile(
      join(cwd, "lesson.md"),
      "# Synthetic semaphore\n\nA synthetic semaphore wakes a waiting task when an event arrives.\n\n![Synthetic event diagram](diagram.png)\n",
    );
    await writeFile(
      join(agent, "models.json"),
      JSON.stringify({
        providers: {
          "pi-e2e": {
            baseUrl: `${local.base}/v1`,
            api: "openai-completions",
            apiKey: "synthetic-only",
            models: [
              {
                id: "synthetic-driver",
                contextWindow: 128000,
                maxTokens: 2048,
              },
            ],
          },
        },
      }),
    );
    await writeFile(
      join(agent, "settings.json"),
      JSON.stringify({
        compaction: { enabled: false },
        retry: { enabled: false },
        defaultProjectTrust: "no",
      }),
    );
    // Allowlist environment: never inherit credentials, provider URLs, extension settings or NODE_OPTIONS.
    const env = {
      ...hostSettings.env,
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: home,
      TMPDIR: root,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
      PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      NO_COLOR: "1",
      PI_KS_V2_EMBED_ENDPOINT: `${local.base}/embed`,
      PI_KS_V2_EMBED_PROVIDER: "synthetic",
      PI_KS_V2_EMBED_MODEL: "synthetic-embedding",
      PI_KS_V2_EMBED_REVISION: "v1",
      PI_KS_V2_EMBED_DIMENSION: "4",
      PI_KS_V2_EMBED_KIND: "wemm",
      PI_KS_V2_GENERATE_ENDPOINT: `${local.base}/generate`,
      PI_KS_V2_GENERATE_MODEL: "synthetic-generation",
      PI_KS_V2_GENERATE_TIMEOUT_MS: String(generationTimeoutMs),
      // Deliberately present: RPC confirmation denial MUST win over host grants.
      PI_KS_V2_HEADLESS_GRANTS:
        "import,list,index,embedding,search,generate,export,remove",
    };
    if (live) {
      // Read-only gate: never repair services or tunnels, never retry inference.
      const initial = await qwenObservation();
      observations.push({ phase: "initial", ...initial });
      requireIdleQwen(initial);
      // Explicit opt-in, fixed pre-existing loopback services, synthetic source only.
      const health = await fetch("http://127.0.0.1:18083/health", {
        signal: AbortSignal.timeout(5000),
      }).then((r) => r.json());
      assert.ok(
        health.model_id && health.model_revision,
        "Live WeMM identity unavailable",
      );
      Object.assign(env, {
        PI_KS_V2_EMBED_ENDPOINT: "http://127.0.0.1:18083/embed",
        PI_KS_V2_EMBED_PROVIDER: "wemm",
        PI_KS_V2_EMBED_MODEL: health.model_id,
        PI_KS_V2_EMBED_REVISION: health.model_revision,
        PI_KS_V2_EMBED_DIMENSION: "512",
        PI_KS_V2_GENERATE_ENDPOINT:
          "http://127.0.0.1:18082/v1/chat/completions",
        PI_KS_V2_GENERATE_MODEL: "qwen3.8-27b-q5",
      });
    }
    rpc = new Rpc(cli, cwd, env, record);
    async function call(name, args, allow, denied = false) {
      const started = Date.now();
      let response;
      try {
        response = await rpc.call(
          `ks_v2_${name}`,
          { collection: "synthetic", ...args },
          allow,
          denied,
        );
      } catch (error) {
        operations.push({
          tool: name,
          denied,
          failed: true,
          elapsedMs: Date.now() - started,
        });
        throw error;
      }
      operations.push({
        tool: name,
        denied,
        confirmations: response.confirmations,
        elapsedMs: Date.now() - started,
      });
      assert.ok(
        response.confirmations.length,
        "Operation skipped real RPC confirmation",
      );
      return denied ? response : payload(response);
    }
    const before = await snapshot(cwd);
    await call("import", { path: "lesson.md" }, [], true);
    assert.deepEqual(await snapshot(cwd), before);
    const imported = await call("import", { path: "lesson.md" }, ["import"]);
    assert.equal(imported.images, 1);
    const listed = await call("list", {}, ["list"]);
    assert.match(JSON.stringify(listed), new RegExp(imported.id));
    const preIndex = local.counts.embedding;
    await call("index", {}, ["index"], true);
    assert.equal(local.counts.embedding, preIndex);
    await call("index", {}, ["index", "embedding"]);
    const searched = await call(
      "search",
      { query: "synthetic semaphore", mode: "hybrid" },
      ["search", "embedding"],
    );
    assert.ok(searched.bundle.texts.length && searched.bundle.images.length);
    const preGenerate = local.counts.generation;
    await call(
      "generate",
      {
        query: generationQuestion,
        title: generationTitle,
        figurePolicy: generationFigurePolicy,
        output: "denied",
      },
      ["search"],
      true,
    );
    assert.equal(local.counts.generation, preGenerate);
    if (live) {
      const beforeGeneration = await qwenObservation();
      observations.push({ phase: "before-generation", ...beforeGeneration });
      requireIdleQwen(beforeGeneration);
    }
    const generated = await call(
      "generate",
      {
        query: generationQuestion,
        title: generationTitle,
        figurePolicy: generationFigurePolicy,
        output: "generated",
      },
      ["search", "generate", "export"],
    );
    assert.equal(generated.status, "answered");
    assert.equal(generated.assessment.question, generationQuestion);
    assert.equal(generated.assessment.semanticProof, false);
    assert.ok(generated.assessment.requirements.length > 0);
    assert.ok(generated.assessment.requirements.every((item) => item.status === "supported"));
    assert.ok(generated.assessment.figures.length > 0, "Required policy needs a selected figure");
    for (const figure of generated.assessment.figures) {
      const requirement = generated.assessment.requirements.find((item) => item.id === figure.requirementId);
      assert.ok(requirement);
      assert.ok(figure.justification.trim());
      assert.ok(figure.evidenceIds.length > 0);
      assert.ok(figure.evidenceIds.every((id) => requirement.evidenceIds.includes(id)));
    }
    assert.equal(generated.generatedByModel, true);
    assert.equal(generated.semanticProof, false);
    const generatedPackage = await verifyPackage(generated.path, original);
    const beforeExportDeny = await snapshot(cwd);
    await call(
      "export",
      { query: "synthetic semaphore", output: "denied" },
      [],
      true,
    );
    assert.deepEqual(await snapshot(cwd), beforeExportDeny);
    const exported = await call(
      "export",
      { query: "synthetic semaphore", output: "evidence" },
      ["export"],
    );
    const evidencePackage = await verifyPackage(exported.path, original);
    await rpc.close();
    rpc = new Rpc(cli, cwd, env, record);
    const recovered = await call("list", {}, ["list"]);
    assert.deepEqual(recovered, listed);
    const recoveredSearch = await call(
      "search",
      { query: "synthetic semaphore", mode: "hybrid" },
      ["search", "embedding"],
    );
    assert.deepEqual(recoveredSearch.bundle.texts, searched.bundle.texts);
    const beforeRemove = await snapshot(cwd);
    await call("remove", { documentId: imported.id }, [], true);
    assert.deepEqual(await snapshot(cwd), beforeRemove);
    const afterDeniedRemove = await call("list", {}, ["list"]);
    assert.deepEqual(afterDeniedRemove, listed);
    assert.deepEqual(local.errors, []);
    const result = {
      ...runMetadata,
      finishedAt: new Date().toISOString(),
      observations,
      status: "passed",
      runner: "real Pi bundled CLI RPC",
      modelProof: live
        ? "live WeMM embeddings + live qwen generation; synthetic agent driver"
        : "deterministic loopback models, NOT real-model quality proof",
      approval:
        "real RPC UI protocol, automated confirmation responses; NOT human TUI approval",
      restart: "new Pi process, same isolated collection; NOT session replay",
      operations,
      counts: local.counts,
      counterScope,
      generationTimeoutMs,
      elapsedMs: Date.now() - startedAt,
      generationQuestion,
      generationTitle,
      generationFigurePolicy,
      generatedAssessment: generated.assessment,
      generatedPackage,
      evidencePackage,
    };
    await writeFile(join(root, "result.json"), JSON.stringify(result, null, 2));
    return { ...result, artifacts: keep ? root : "removed (use --keep)" };
  } catch (error) {
    if (live && /timed?\s*out|timeout/i.test(String(error))) {
      try {
        observations.push({ phase: "after-timeout-read-only", ...await qwenObservation() });
      } catch (inspectionError) {
        observations.push({ phase: "after-timeout-read-only", error: String(inspectionError) });
      }
    }
    await writeFile(
      join(root, "failure.json"),
      JSON.stringify(
        {
          ...runMetadata,
          finishedAt: new Date().toISOString(),
          observations,
          status: "failed",
          live,
          generationTimeoutMs,
          elapsedMs: Date.now() - startedAt,
          operations,
          counts: local.counts,
          counterScope,
          error: String(error)
            .replaceAll(root, "<TEMP>")
            .replaceAll(repo, "<REPO>"),
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    await rpc?.close();
    await new Promise((resolve) => {
      local.server.close(resolve);
      local.server.closeAllConnections();
    });
    await writeFile(join(root, "rpc-sanitized.jsonl"), log.join("\n") + "\n");
    if (keep) console.error(`Synthetic acceptance artifacts: ${root}`);
    else await rm(root, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const options = new Set(process.argv.slice(2));
  for (const option of options)
    assert.ok(
      ["--keep", "--live"].includes(option),
      `Unknown option: ${option}`,
    );
  runSmoke({ keep: options.has("--keep"), live: options.has("--live") })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
// @ts-expect-error Standalone JavaScript harness has no declaration file.
import { generationHostSettings, runSmoke } from "../scripts/pi-e2e-smoke.mjs";

const controls = {
  PI_KS_V2_GENERATE_PROTOCOL: "llama.cpp",
  PI_KS_V2_GENERATE_MAX_TOKENS: "2048",
  PI_KS_V2_GENERATE_ENABLE_THINKING: "false",
  PI_KS_V2_GENERATE_REASONING_BUDGET_TOKENS: "0",
};
const cleanEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !key.startsWith("PI_KS_V2_GENERATE_")));


const cli =
  "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
const script = fileURLToPath(
  new URL("../scripts/pi-e2e-smoke.mjs", import.meta.url),
);

for (const configured of [false, true]) test(`real Pi RPC: lifecycle, recovery and denials (${configured ? "explicit controls" : "defaults"})`, {
  timeout: 240_000,
}, async (t) => {
  try {
    await access(cli);
  } catch {
    t.skip(
      "Installed Pi bundled CLI unavailable; not an execution acceptance pass",
    );
    return;
  }
  const { stdout } = await promisify(execFile)(process.execPath, [script], {
    timeout: 230_000,
    maxBuffer: 2_000_000,
    env: { ...cleanEnv, ...(configured ? controls : {}), PI_KS_V2_GENERATE_TIMEOUT_MS: "180000" },
  });
  const result = JSON.parse(stdout);
  assert.equal(result.status, "passed");
  assert.deepEqual(result.hostProfile, configured ? {
    protocol: "llama.cpp", maxTokens: 2048, enableThinking: false, reasoningBudgetTokens: 0,
  } : null);
  assert.deepEqual(result.generationPayload, configured ? {
    max_tokens: 2048, chat_template_kwargs: { enable_thinking: false }, reasoning_budget_tokens: 0,
  } : {});
  assert.deepEqual(result.observations, []);
  assert.ok(Date.parse(result.finishedAt) >= Date.parse(result.startedAt));
  assert.equal(result.generationTimeoutMs, 180000);
  assert.equal(result.answerContract, "grounded-answer-v2");
  assert.equal(result.generationQuestion, "How does the synthetic semaphore wake a waiting task?");
  assert.equal(result.generationTitle, "Synthetic guide");
  assert.notEqual(result.generationQuestion, result.generationTitle);
  assert.equal(result.generationFigurePolicy, "required");
  assert.equal(result.generatedAssessment.question, result.generationQuestion);
  assert.equal(result.generatedAssessment.semanticProof, false);
  assert.equal(result.generatedAssessment.requirements[0].status, "supported");
  assert.equal(result.generatedAssessment.figures.length, 1);
  assert.ok(result.generatedAssessment.figures[0].justification);
  assert.equal(
    result.counterScope,
    "All deterministic loopback model requests",
  );
  assert.ok(
    result.operations.every(
      (operation: { elapsedMs: number }) => operation.elapsedMs >= 0,
    ),
  );
  assert.equal(result.operations.length, 14);
  assert.equal(
    result.operations.filter(
      (operation: { denied: boolean }) => operation.denied,
    ).length,
    5,
  );
  assert.deepEqual(result.counts, { agent: 28, embedding: 3, generation: 1 });
  assert.equal(
    result.generatedPackage.originalSha256,
    result.evidencePackage.originalSha256,
  );
  assert.equal(result.generatedPackage.images, 1);
  assert.equal(result.generatedPackage.texts, 1);
  assert.match(result.approval, /NOT human TUI/);
  assert.match(result.modelProof, /NOT real-model quality proof/);
});

test("smoke rejects host generation deadlines above the application maximum", async () => {
  await assert.rejects(
    promisify(execFile)(process.execPath, [script], {
      env: { ...cleanEnv, PI_KS_V2_GENERATE_TIMEOUT_MS: "180001" },
      timeout: 5000,
    }),
    /must be an integer from 1000 to 180000/,
  );
});


test("host defaults and exact control allowlist exclude secrets/config", () => {
  assert.deepEqual(generationHostSettings({}), { env: {}, timeoutMs: 120000, profile: null, payload: {} });
  const settings = generationHostSettings({ ...controls, PI_KS_V2_GENERATE_API_KEY: "do-not-copy",
    PI_KS_V2_GENERATE_ENDPOINT: "https://do-not-use.invalid", OPENAI_API_KEY: "do-not-copy",
    NODE_OPTIONS: "do-not-copy", PI_KS_V2_EMBED_ENDPOINT: "do-not-copy" });
  assert.deepEqual(settings.env, controls);
});

test("malformed controls fail before live fetch, listeners or Pi startup", async () => {
  const originalEnv = process.env;
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("Unexpected network egress"); };
  try {
    for (const invalid of [
      { PI_KS_V2_GENERATE_MAX_TOKENS: "2048" },
      { ...controls, PI_KS_V2_GENERATE_PROTOCOL: "auto" },
      { ...controls, PI_KS_V2_GENERATE_MAX_TOKENS: "02048" },
      { ...controls, PI_KS_V2_GENERATE_MAX_TOKENS: "0" },
      { ...controls, PI_KS_V2_GENERATE_MAX_TOKENS: "32769" },
      { ...controls, PI_KS_V2_GENERATE_ENABLE_THINKING: "False" },
      { ...controls, PI_KS_V2_GENERATE_REASONING_BUDGET_TOKENS: "-1" },
      { ...controls, PI_KS_V2_GENERATE_REASONING_BUDGET_TOKENS: "1.5" },
      { ...controls, PI_KS_V2_GENERATE_UNKNOWN: "1" },
      { ...controls, PI_KS_V2_GENERATE_TIMEOUT_MS: " 180000" },
    ]) {
      process.env = { ...cleanEnv, ...invalid };
      await assert.rejects(runSmoke({ live: true, cli: "/must-not-start" }),
        /Host answer generation|Unsupported host answer|Invalid answer generation|must be an integer/);
    }
    assert.equal(requests, 0, "Invalid settings must not reach even health checks");
  } finally {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  }
});

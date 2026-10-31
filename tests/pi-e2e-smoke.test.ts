import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
// @ts-expect-error Standalone JavaScript harness has no declaration file.
import { generationHostSettings, resolvePiCli, runSmoke } from "../scripts/pi-e2e-smoke.mjs";

const controls = {
  PI_KS_V2_GENERATE_PROTOCOL: "llama.cpp",
  PI_KS_V2_GENERATE_MAX_TOKENS: "2048",
  PI_KS_V2_GENERATE_ENABLE_THINKING: "false",
  PI_KS_V2_GENERATE_REASONING_BUDGET_TOKENS: "0",
};
const cleanEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !key.startsWith("PI_KS_V2_GENERATE_")));


const script = fileURLToPath(
  new URL("../scripts/pi-e2e-smoke.mjs", import.meta.url),
);

for (const configured of [false, true]) test(`real Pi RPC: lifecycle, recovery and denials (${configured ? "explicit controls" : "defaults"})`, {
  timeout: 240_000,
}, async (t) => {
  // Explicit invalid overrides throw here; only absent default discovery may skip.
  const cli = resolvePiCli();
  if (!cli) {
    t.skip("Pi JS CLI unavailable via package bin or PATH; set PI_KS_PI_CLI. Not an execution acceptance pass");
    return;
  }
  const { stdout } = await promisify(execFile)(process.execPath, [script], {
    timeout: 230_000,
    maxBuffer: 2_000_000,
    env: { ...cleanEnv, ...(configured ? controls : {}), PI_KS_PI_CLI: cli, PI_KS_V2_GENERATE_TIMEOUT_MS: "180000" },
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
      process.env = { ...cleanEnv, ...invalid, PI_KS_PI_CLI: "/must-not-start" };
      await assert.rejects(runSmoke({ live: true }),
        /Host answer generation|Unsupported host answer|Invalid answer generation|must be an integer/);
    }
    assert.equal(requests, 0, "Invalid settings must not reach even health checks");
  } finally {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  }
});

test("CLI resolver locates package bin, PATH symlink and host override without executing them", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cli-resolver-"));
  try {
    const requireFrom = pathToFileURL(join(root, "probe.mjs"));
    const packageDir = join(root, "node_modules/@earendil-works/pi-coding-agent");
    const cli = join(packageDir, "dist/cli.js");
    const binDir = join(root, "bin");
    await mkdir(join(packageDir, "dist"), { recursive: true });
    await mkdir(binDir);
    await writeFile(cli, 'throw new Error("Must not import/execute during discovery");\n');
    const manifest = { name: "@earendil-works/pi-coding-agent", bin: { pi: "dist/cli.js" } };
    await writeFile(join(packageDir, "package.json"), JSON.stringify(manifest));
    assert.equal(resolvePiCli({ host: { PATH: "" }, requireFrom }), cli);
    // Use a fresh package location so Node's manifest resolution cache cannot
    // mask the import-only/hidden-manifest case.
    const hiddenDir = join(root, "hidden/node_modules/@earendil-works/pi-coding-agent");
    const hiddenCli = join(hiddenDir, "custom-entry.mjs");
    await mkdir(hiddenDir, { recursive: true });
    await writeFile(hiddenCli, 'throw new Error("Must not execute");\n');
    await writeFile(join(hiddenDir, "package.json"), JSON.stringify({
      ...manifest, bin: { pi: "custom-entry.mjs" }, exports: { ".": { import: "./dist/index.js" } },
    }));
    assert.equal(resolvePiCli({ host: { PATH: "" },
      requireFrom: pathToFileURL(join(root, "hidden/probe.mjs")) }), hiddenCli);
    await symlink(cli, join(binDir, "pi"));
    assert.equal(resolvePiCli({ host: { PI_KS_PI_CLI: join(binDir, "pi") }, requireFrom }), cli);
    await rm(join(packageDir, "package.json"));
    assert.equal(resolvePiCli({ host: { PATH: binDir }, requireFrom }), cli);
    assert.equal(resolvePiCli({ host: { PATH: "" }, requireFrom }), undefined);
    // A valid PATH candidate must not mask invalid explicit configuration.
    for (const invalid of ["", join(root, "missing.js"), root, join(binDir, "wrapper")]) {
      await writeFile(join(binDir, "wrapper"), "#!/bin/sh\nexit 0\n");
      assert.throws(() => resolvePiCli({ host: { PI_KS_PI_CLI: invalid, PATH: binDir }, requireFrom }),
        /Invalid PI_KS_PI_CLI/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("smoke fails on invalid CLI override before live observations or temporary resources", async () => {
  await assert.rejects(promisify(execFile)(process.execPath, [script, "--live"], {
    env: { ...cleanEnv, PI_KS_PI_CLI: "/must-not-exist/pi-cli.js" }, timeout: 5000,
  }), /Invalid PI_KS_PI_CLI/);
});

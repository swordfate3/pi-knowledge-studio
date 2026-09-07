import assert from "node:assert/strict";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import v2 from "../extensions/v2.ts";
function register(grants: string, config?: string) {
  const saved = { ...process.env };
  process.env.PI_KS_V2_HEADLESS_GRANTS = grants;
  if (config) process.env.PI_KS_V2_OCR_CONFIG = config;
  else delete process.env.PI_KS_V2_OCR_CONFIG;
  const tools = new Map<string, ToolDefinition>();
  try {
    v2({
      registerCommand() {},
      registerTool: (tool: ToolDefinition) => {
        tools.set(tool.name, tool);
      },
    } as unknown as ExtensionAPI);
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
  return tools;
}
test("OCR requires a separate grant; no model paths and no config IO at registration", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ks-ocr-consent-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await copyFile(
    resolve("tests/fixtures/ocr/bilingual-scanned.pdf"),
    join(cwd, "input.pdf"),
  );
  const tools = register("import", "/missing-config");
  const tool = tools.get("ks_v2_import")!;
  assert.doesNotMatch(
    JSON.stringify(tool.parameters),
    /configPath|executable|tessdata/,
  );
  const ctx = { cwd, hasUI: false } as ExtensionContext;
  await assert.rejects(
    tool.execute(
      "x",
      { collection: "demo", path: "input.pdf", ocr: true },
      undefined,
      undefined,
      ctx,
    ),
    /ocr denied/,
  );
  assert.deepEqual(await readdir(cwd), ["input.pdf"]);
  const approved = register("import,ocr");
  await assert.rejects(
    approved
      .get("ks_v2_import")!
      .execute(
        "x",
        { collection: "demo", path: "input.pdf", ocr: true },
        undefined,
        undefined,
        ctx,
      ),
    /OCR_UNAVAILABLE: host/,
  );
});
test("real extension OCR config is registration-snapshotted and consent precedes execution", {
  skip:
    !process.env.PI_KS_OCR_TEST_CONFIG && !process.env.PI_KS_OCR_TEST_REQUIRED,
}, async (t) => {
  const config = process.env.PI_KS_OCR_TEST_CONFIG;
  assert.ok(config);
  const cwd = await mkdtemp(join(tmpdir(), "ks-ocr-consent-real-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await copyFile(
    resolve("tests/fixtures/ocr/bilingual-scanned.pdf"),
    join(cwd, "input.pdf"),
  );
  const tools = register("", config);
  const approvals: string[] = [];
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      confirm: async (title: string, message: string) => {
        approvals.push(title);
        if (title.endsWith(": ocr")) {
          assert.match(message, /EVERY PDF page/);
          assert.match(message, /Unverified OCR/);
        }
        return true;
      },
    },
  } as unknown as ExtensionContext;
  const imported = await tools
    .get("ks_v2_import")!
    .execute(
      "x",
      { collection: "demo", path: "input.pdf", ocr: true },
      undefined,
      undefined,
      ctx,
    );
  assert.match(JSON.stringify(imported), /unverified/);
  assert.deepEqual(approvals, [
    "Knowledge Studio V2: import",
    "Knowledge Studio V2: ocr",
  ]);
  const searched = await tools
    .get("ks_v2_search")!
    .execute(
      "x",
      { collection: "demo", query: "知识 检索" },
      undefined,
      undefined,
      ctx,
    );
  assert.match(JSON.stringify(searched), /page_render/);
  assert.match(JSON.stringify(searched), /transcriptHash/);
});

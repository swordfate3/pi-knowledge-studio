import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import extension from "../extensions/index.ts";
import {
  parseStudioCommand,
  runStudioCommand,
} from "../src/studio-command.ts";

function context(options: {
  hasUI?: boolean;
  selected?: string | undefined;
  notifications?: Array<{ message: string; level: string }>;
} = {}): ExtensionCommandContext {
  const notifications = options.notifications ?? [];
  return {
    cwd: "/workspace",
    hasUI: options.hasUI ?? true,
    signal: undefined,
    ui: {
      async select() {
        return options.selected;
      },
      notify(message: string, level: "info" | "warning" | "error" = "info") {
        notifications.push({ message, level });
      },
    } as unknown as ExtensionUIContext,
  } as unknown as ExtensionCommandContext;
}

test("Studio extension registers a discoverable /studio command", () => {
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  extension({
    registerTool() {},
    registerCommand(
      name: string,
      command: Omit<RegisteredCommand, "name" | "sourceInfo">,
    ) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI);
  assert.ok(commands.has("studio"));
  assert.match(commands.get("studio")?.description ?? "", /知识工作室|Knowledge Studio/);
});

test("Studio command parses common workflows into explicit tool requests", () => {
  assert.deepEqual(parseStudioCommand(""), { kind: "menu" });
  assert.deepEqual(parseStudioCommand("help"), { kind: "help" });

  const imported = parseStudioCommand('import freertos "docs/FreeRTOS 笔记.md"');
  assert.equal(imported.kind, "prompt");
  if (imported.kind === "prompt") {
    assert.match(imported.prompt, /ks_v2_import/);
    assert.match(imported.prompt, /docs\/FreeRTOS 笔记\.md/);
    assert.match(imported.prompt, /保留全部授权确认/);
  }

  const generated = parseStudioCommand(
    'generate freertos mutex "优先级继承详解" | "互斥量与优先级继承"',
  );
  assert.equal(generated.kind, "prompt");
  if (generated.kind === "prompt") {
    assert.match(generated.prompt, /ks_v2_generate/);
    assert.match(generated.prompt, /优先级继承详解/);
    assert.match(generated.prompt, /互斥量与优先级继承/);
    assert.match(generated.prompt, /figurePolicy=selective/);
  }

  const pdf = parseStudioCommand('pdf "books/FreeRTOS 内核.pdf"');
  assert.equal(pdf.kind, "prompt");
  if (pdf.kind === "prompt") {
    assert.match(pdf.prompt, /ks_v2_pdf_start/);
    assert.match(pdf.prompt, /index=false/);
  }
});

test("Studio command reports invalid syntax without starting an agent turn", async () => {
  const notifications: Array<{ message: string; level: string }> = [];
  const prompts: string[] = [];
  await runStudioCommand("search only-one-argument", context({ notifications }), (prompt) =>
    prompts.push(prompt),
  );
  assert.deepEqual(prompts, []);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.level, "warning");
  assert.match(notifications[0]?.message ?? "", /参数不足/);

  const unclosed = parseStudioCommand('import demo "open');
  assert.equal(unclosed.kind, "error");
});

test("bare /studio opens a menu and sends the selected workflow", async () => {
  const prompts: string[] = [];
  await runStudioCommand(
    "",
    context({ selected: "搜索资料" }),
    (prompt) => prompts.push(prompt),
  );
  assert.equal(prompts.length, 1);
  assert.match(prompts[0] ?? "", /ks_v2_search/);
  assert.match(prompts[0] ?? "", /默认先用 lexical/);
});

test("bare /studio fails locally when interactive UI is unavailable", async () => {
  const notifications: Array<{ message: string; level: string }> = [];
  const prompts: string[] = [];
  await runStudioCommand(
    "",
    context({ hasUI: false, notifications }),
    (prompt) => prompts.push(prompt),
  );
  assert.deepEqual(prompts, []);
  assert.deepEqual(notifications, [
    {
      message: "当前模式不支持交互菜单；请输入 /studio help 查看命令。",
      level: "warning",
    },
  ]);
});

test("/studio help is local and documents the safety boundary", async () => {
  const notifications: Array<{ message: string; level: string }> = [];
  const prompts: string[] = [];
  await runStudioCommand("help", context({ notifications }), (prompt) =>
    prompts.push(prompt),
  );
  assert.deepEqual(prompts, []);
  assert.equal(notifications[0]?.level, "info");
  assert.match(notifications[0]?.message ?? "", /\/studio import/);
  assert.match(notifications[0]?.message ?? "", /studio-permissions all\|off\|status/);
});

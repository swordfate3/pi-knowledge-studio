import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export const STUDIO_COMMAND_DESCRIPTION =
  "打开知识工作室，或用 /studio <操作> 执行导入、搜索、导出和 PDF 工作流";

const ACTIONS = [
  "导入资料",
  "查看知识库",
  "搜索资料",
  "导出证据包",
  "生成图文文档",
  "PDF 书籍工作流",
  "查看帮助",
] as const;

type Action = (typeof ACTIONS)[number];

type ParsedStudioCommand =
  | { kind: "menu" }
  | { kind: "help" }
  | { kind: "prompt"; prompt: string }
  | { kind: "error"; message: string };

function usage(): string {
  return [
    "# Knowledge Studio 命令",
    "",
    "直接输入 `/studio` 可打开交互菜单。也可使用：",
    "",
    "- `/studio import <知识库> <文件路径>` — 导入资料",
    "- `/studio list <知识库>` — 查看知识库中的文档",
    "- `/studio search <知识库> <问题>` — 搜索证据",
    "- `/studio export <知识库> <输出名> <主题>` — 导出证据包",
    "- `/studio generate <知识库> <输出名> <标题> | <主题>` — 生成带来源文档",
    "- `/studio pdf <PDF路径>` — 导入一本 PDF 书籍",
    "- `/studio books` — 列出书名、短引用和处理进度",
    "- `/studio books <书名或B-短引用>` — 查看一本 PDF 的处理状态",
    "- `/studio book-search <书名或B-短引用> <问题>` — 搜索已解析的 PDF 书籍",
    "- `/studio help` — 查看帮助",
    "- `/studio-permissions all|off|status` — 本次扩展会话启用/关闭/查看全部权限（仅可信本地会话）",
    "",
    "含空格的路径、标题或问题可使用引号。例：",
    "",
    '```text\n/studio import freertos "docs/FreeRTOS 笔记.md"\n/studio search freertos "优先级继承如何工作？"\n/studio generate freertos priority-inheritance "优先级继承详解" | "互斥量与优先级继承"\n/studio pdf "books/FreeRTOS 内核实现与应用开发实战指南.pdf"\n```',
    "",
    "Studio 默认仍会显示必要的文件访问、内容披露、模型调用和导出确认；如明确输入 /studio-permissions all，则本次扩展会话不再询问 Knowledge Studio 授权，直到 off 或重新加载扩展。",
  ].join("\n");
}

function tokenize(input: string): string[] | null {
  const result: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < input.trim().length; index += 1) {
    const character = input.trim()[index] ?? "";
    const next = input.trim()[index + 1];
    if (character === "\\" && (next === "\\" || next === '"' || next === "'" || (next !== undefined && /\s/.test(next)))) {
      current += next;
      index += 1;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        result.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }

  if (quote) return null;
  if (current) result.push(current);
  return result;
}

function promptFor(action: Action): string {
  switch (action) {
    case "导入资料":
      return "我想使用 Knowledge Studio 导入资料。请询问知识库名称和工作区内的文件路径，然后调用 ks_v2_import；若信息已足够就直接调用。不要绕过任何授权确认。";
    case "查看知识库":
      return "我想查看 Knowledge Studio 知识库。请询问知识库名称，然后调用 ks_v2_list；若上下文已有明确名称就直接调用。不要绕过任何授权确认。";
    case "搜索资料":
      return "我想搜索 Knowledge Studio。请询问知识库名称和问题，然后调用 ks_v2_search；默认先用 lexical 模式，除非我明确要求 hybrid。不要绕过任何授权确认。";
    case "导出证据包":
      return "我想用 Knowledge Studio 导出证据包。请询问知识库名称、输出名和检索主题，然后调用 ks_v2_export；默认用 lexical 模式。不要绕过任何授权确认。";
    case "生成图文文档":
      return "我想用 Knowledge Studio 生成带来源的图文文档。请询问知识库名称、输出名、文档标题和检索主题，然后调用 ks_v2_generate；默认用 lexical 模式和 selective figure policy。不要绕过任何授权确认。";
    case "PDF 书籍工作流":
      return "我想使用 Knowledge Studio 的 PDF 书籍工作流。请先调用 ks_v2_pdf_books 列出现有书籍；如果我要导入新书，再询问工作区内的 PDF 路径并调用 ks_v2_pdf_start。默认只解析，不建立 embedding 索引，除非我明确要求。后续只使用返回的书名或 B-短引用，不要让我复制内部 bookId。不要绕过任何授权确认。";
    case "查看帮助":
      return usage();
  }
}

export function parseStudioCommand(args: string): ParsedStudioCommand {
  const tokens = tokenize(args);
  if (!tokens) return { kind: "error", message: "引号没有闭合。请补全引号后重试，或输入 /studio help。" };
  if (tokens.length === 0) return { kind: "menu" };

  const [rawAction = "", ...values] = tokens;
  const action = rawAction.toLowerCase();
  if (action === "help" || action === "帮助" || action === "-h" || action === "--help") {
    return { kind: "help" };
  }

  const requireValues = (count: number, syntax: string): string | null =>
    values.length >= count ? null : `参数不足。用法：${syntax}\n输入 /studio help 查看完整帮助。`;

  switch (action) {
    case "import":
    case "导入": {
      const error = requireValues(2, "/studio import <知识库> <文件路径>");
      if (error) return { kind: "error", message: error };
      const [collection, ...pathParts] = values;
      return {
        kind: "prompt",
        prompt: `使用 Knowledge Studio 将工作区文件 ${JSON.stringify(pathParts.join(" "))} 导入知识库 ${JSON.stringify(collection)}。请直接调用 ks_v2_import，并保留全部授权确认。`,
      };
    }
    case "list":
    case "查看": {
      const error = requireValues(1, "/studio list <知识库>");
      if (error) return { kind: "error", message: error };
      return {
        kind: "prompt",
        prompt: `使用 Knowledge Studio 查看知识库 ${JSON.stringify(values[0])} 的文档。请直接调用 ks_v2_list，并保留内容披露确认。`,
      };
    }
    case "search":
    case "搜索": {
      const error = requireValues(2, "/studio search <知识库> <问题>");
      if (error) return { kind: "error", message: error };
      const [collection, ...queryParts] = values;
      return {
        kind: "prompt",
        prompt: `使用 Knowledge Studio 在知识库 ${JSON.stringify(collection)} 中搜索 ${JSON.stringify(queryParts.join(" "))}。请直接调用 ks_v2_search，使用 lexical 模式，limit=5，并保留内容披露确认。`,
      };
    }
    case "export":
    case "导出": {
      const error = requireValues(3, "/studio export <知识库> <输出名> <主题>");
      if (error) return { kind: "error", message: error };
      const [collection, output, ...queryParts] = values;
      return {
        kind: "prompt",
        prompt: `使用 Knowledge Studio 从知识库 ${JSON.stringify(collection)} 导出主题 ${JSON.stringify(queryParts.join(" "))} 的证据包，输出名为 ${JSON.stringify(output)}。请直接调用 ks_v2_export，使用 lexical 模式，并保留全部授权确认。`,
      };
    }
    case "generate":
    case "生成": {
      const error = requireValues(3, "/studio generate <知识库> <输出名> <标题> | <主题>");
      if (error) return { kind: "error", message: error };
      const separator = values.indexOf("|");
      const [collection, output] = values;
      const title = (separator >= 0 ? values.slice(2, separator) : values.slice(2)).join(" ");
      const query = separator >= 0 ? values.slice(separator + 1).join(" ") : title;
      if (!title || !query) {
        return { kind: "error", message: "标题或主题为空。用法：/studio generate <知识库> <输出名> <标题> | <主题>" };
      }
      return {
        kind: "prompt",
        prompt: `使用 Knowledge Studio 基于知识库 ${JSON.stringify(collection)} 生成文档，输出名 ${JSON.stringify(output)}，标题 ${JSON.stringify(title)}，检索主题 ${JSON.stringify(query)}。请直接调用 ks_v2_generate，使用 lexical 模式、limit=8、figurePolicy=selective，并保留全部授权确认。`,
      };
    }
    case "pdf": {
      const error = requireValues(1, "/studio pdf <PDF路径>");
      if (error) return { kind: "error", message: error };
      return {
        kind: "prompt",
        prompt: `使用 Knowledge Studio 导入并解析工作区 PDF ${JSON.stringify(values.join(" "))}。请直接调用 ks_v2_pdf_start，index=false，并保留文件读取确认。完成后告诉我返回的书名、B-短引用，以及 /studio books 和 /studio book-search 的用法；不要让我复制内部 bookId。`,
      };
    }
    case "books": {
      if (values.length === 0) {
        return {
          kind: "prompt",
          prompt: "列出 Knowledge Studio 中已有的 PDF 书籍、B-短引用、解析进度和可检索状态。请直接调用 ks_v2_pdf_books。不要显示或要求我复制内部 bookId。",
        };
      }
      return {
        kind: "prompt",
        prompt: `查看 Knowledge Studio PDF 书籍 ${JSON.stringify(values.join(" "))} 的处理状态。它可以是书名或 B-短引用；请直接调用 ks_v2_pdf_status。`,
      };
    }
    case "status":
    case "状态": {
      const error = requireValues(1, "/studio status <书名或B-短引用>");
      if (error) return { kind: "error", message: error };
      return {
        kind: "prompt",
        prompt: `查看 Knowledge Studio PDF 书籍 ${JSON.stringify(values.join(" "))} 的处理状态。它可以是书名或 B-短引用；请直接调用 ks_v2_pdf_status。`,
      };
    }
    case "book-search":
    case "书籍搜索": {
      const error = requireValues(2, "/studio book-search <书名或B-短引用> <问题>");
      if (error) return { kind: "error", message: error };
      const [book, ...queryParts] = values;
      return {
        kind: "prompt",
        prompt: `使用 Knowledge Studio 在 PDF 书籍 ${JSON.stringify(book)} 中搜索 ${JSON.stringify(queryParts.join(" "))}。书籍参数可以是书名或 B-短引用；请直接调用 ks_v2_pdf_search，使用 lexical 模式、limit=5，并保留内容披露确认。`,
      };
    }
    default:
      return { kind: "error", message: `未知操作：${rawAction}\n输入 /studio help 查看可用命令。` };
  }
}

export async function runStudioCommand(
  args: string,
  ctx: ExtensionCommandContext,
  sendUserMessage: (prompt: string) => void,
): Promise<void> {
  let parsed = parseStudioCommand(args);

  if (parsed.kind === "menu") {
    if (!ctx.hasUI) {
      ctx.ui.notify("当前模式不支持交互菜单；请输入 /studio help 查看命令。", "warning");
      return;
    }
    const selected = await ctx.ui.select("Knowledge Studio — 请选择操作", [...ACTIONS]);
    if (!selected) return;
    parsed = selected === "查看帮助" ? { kind: "help" } : { kind: "prompt", prompt: promptFor(selected as Action) };
  }

  if (parsed.kind === "help") {
    ctx.ui.notify(usage(), "info");
    return;
  }
  if (parsed.kind === "error") {
    ctx.ui.notify(parsed.message, "warning");
    return;
  }

  sendUserMessage(parsed.prompt);
}

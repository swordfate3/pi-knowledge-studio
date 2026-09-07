import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KnowledgeRuntime } from "../src/application/knowledge-runtime.ts";
import { SqliteCatalog } from "../src/adapters/storage/sqlite-catalog.ts";
import { encodePng } from "../src/adapters/export/encode-png.ts";
import { sha256 } from "../src/adapters/blob/file-blob-store.ts";
import { createVisionHint } from "../src/application/vision-hints.ts";
import type {
  CapturedDocument,
  EmbeddingProvider,
} from "../src/domain/retrieval.ts";

// Closed-world labels: each query has exactly one relevant document, not a
// relevance judgment about all real FreeRTOS documentation. No score tuning.
const corpus = [
  {
    id: "task",
    text: "任务 创建执行单元 xTaskCreate 分配入口和栈。",
    query: "任务",
    image: true,
  },
  {
    id: "queue",
    text: "队列 按顺序复制消息 xQueueSend 放入缓冲区。",
    query: "队列",
    image: true,
  },
  {
    id: "semaphore",
    text: "信号量 记录可用计数 xSemaphoreTake 等待资源。",
    query: "信号量",
    image: true,
  },
  {
    id: "mutex",
    text: "互斥 锁保护共享数据 xSemaphoreCreateMutex 支持优先级继承。",
    query: "互斥",
    image: true,
  },
  {
    id: "timer",
    text: "定时器 到期运行回调 xTimerStart 激活计时。",
    query: "定时器",
    image: true,
  },
  {
    id: "heap",
    text: "堆 动态内存分配 pvPortMalloc 返回地址。",
    query: "堆",
    image: true,
  },
  {
    id: "isr",
    text: "中断 ISR 使用 xQueueSendFromISR 投递并请求切换。",
    query: "ISR",
    image: true,
  },
  {
    id: "queue-static",
    text: "静态创建消息容器 xQueueCreateStatic 由调用者提供存储。",
    query: "xQueueCreateStatic",
    image: false,
  },
  {
    id: "queue-dynamic",
    text: "动态创建消息容器 xQueueCreate 自动分配存储。",
    query: "xQueueCreate",
    image: false,
  },
  {
    id: "task-static",
    text: "静态创建执行单元 xTaskCreateStatic 接收预留栈。",
    query: "xTaskCreateStatic",
    image: false,
  },
  {
    id: "notify",
    text: "通知 直接唤醒目标 xTaskNotifyGive 增加通知值。",
    query: "通知",
    image: false,
  },
  {
    id: "event",
    text: "事件 多个位表示条件 xEventGroupWaitBits 等待位组合。",
    query: "事件",
    image: false,
  },
  {
    id: "stream",
    text: "流 缓冲连续字节 xStreamBufferSend 写入字节序列。",
    query: "流",
    image: false,
  },
  {
    id: "delay",
    text: "延时 vTaskDelay 暂停指定节拍。",
    query: "延时",
    image: false,
  },
  {
    id: "timer-isr",
    text: "回调激活接口 xTimerStartFromISR 可在异常上下文调用。",
    query: "xTimerStartFromISR",
    image: false,
  },
  {
    id: "free",
    text: "释放 vPortFree 归还先前分配的内存块。",
    query: "vPortFree",
    image: false,
  },
] as const;
const semanticCases = [
  { query: "dispatchparcel", gold: "queue" },
  { query: "exclusiveownership", gold: "mutex" },
  { query: "expirycallback", gold: "timer" },
] as const;

// Deliberately an oracle-like lookup, NOT a learned model or quality evidence.
const fakeEmbedding: EmbeddingProvider = {
  space: {
    provider: "offline-fixture",
    model: "fakeEmbedding",
    revision: "1",
    dimension: corpus.length,
    queryInstruction: "",
    documentInstruction: "",
  },
  async embed(texts, purpose) {
    return texts.map((text) => {
      const index =
        purpose === "query"
          ? corpus.findIndex(
              (row) =>
                row.id ===
                semanticCases.find((item) => item.query === text)?.gold,
            )
          : corpus.findIndex((row) => text.includes(row.text));
      assert.ok(
        index >= 0,
        "fakeEmbedding accepts only declared fixture inputs",
      );
      return corpus.map((_, position) => (position === index ? 1 : 0));
    });
  },
};

function diagram(index: number): Buffer {
  // Two colored blocks connected by a horizontal line, unique per source.
  const pixels = Buffer.alloc(12 * 8 * 3, 255);
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 12; x++) {
      if (
        (y >= 2 && y <= 5 && (x <= 3 || x >= 8)) ||
        (y === 3 && x > 3 && x < 8)
      ) {
        const offset = (y * 12 + x) * 3;
        pixels[offset] = 20 + index * 12;
        pixels[offset + 1] = 70;
        pixels[offset + 2] = 150;
      }
    }
  return encodePng(12, 8, 3, pixels);
}

async function evaluate() {
  const root = await mkdtemp(join(tmpdir(), "studio-retrieval-quality-"));
  try {
    const source = join(root, "source");
    await mkdir(source);
    const runtime = new KnowledgeRuntime(join(root, "data"));
    const documents = new Map<string, CapturedDocument>();
    for (const [index, row] of corpus.entries()) {
      if (row.image)
        await writeFile(join(source, `${row.id}.png`), diagram(index));
      const path = join(source, `${row.id}.md`);
      await writeFile(
        path,
        row.text + (row.image ? `\n![示意图](${row.id}.png)` : ""),
      );
      const captured = await runtime.ingest(source, path);
      assert.equal(
        captured.elements.length,
        1,
        "one hit equals one fixture document",
      );
      assert.equal(captured.images.length, row.image ? 1 : 0);
      documents.set(row.id, captured);
    }
    assert.equal(
      new Set([...documents.values()].map((row) => row.id)).size,
      16,
    );
    assert.equal(
      new Set(
        [...documents.values()].flatMap((row) =>
          row.images.map((image) => image.blobHash),
        ),
      ).size,
      7,
    );
    const reopened = new KnowledgeRuntime(runtime.root);
    const rows = [];
    for (const fixture of corpus) {
      const gold = documents.get(fixture.id)!;
      const result = await runtime.search(fixture.query, 5);
      const repeat = await reopened.search(fixture.query, 5);
      assert.deepEqual(
        repeat.hits.map((hit) => hit.document.id),
        result.hits.map((hit) => hit.document.id),
      );
      assert.deepEqual(repeat.bundle.images, result.bundle.images);
      assert.ok(result.hits.length <= 5);
      const recall = Number(
        result.hits.some((hit) => hit.document.id === gold.id),
      );
      const imageRecall = fixture.image
        ? Number(
            result.bundle.images
              .slice(0, 5)
              .some(
                (image) =>
                  image.sourceId === gold.id &&
                  image.blobHash === gold.images[0]!.blobHash,
              ),
          )
        : null;
      assert.equal(recall, 1, `Recall@5 regression: ${fixture.query}`);
      if (imageRecall !== null)
        assert.equal(
          imageRecall,
          1,
          `image Recall@5 regression: ${fixture.query}`,
        );
      // Full identifiers must not degrade into prefix matches (Create/Static,
      // Start/FromISR). This checks observable behavior, not tokenizer internals.
      if (/^[A-Za-z]/.test(fixture.query)) {
        assert.deepEqual(
          result.hits.map((hit) => hit.document.id),
          [gold.id],
        );
      }
      rows.push({
        query: fixture.query,
        gold: fixture.id,
        recall,
        imageRecall,
      });
    }
    await runtime.index(fakeEmbedding);
    const denseRows = [];
    for (const item of semanticCases) {
      await assert.rejects(
        runtime.search(item.query, 5),
        /No relevant evidence found/,
      );
      const result = await reopened.search(item.query, 5, fakeEmbedding);
      assert.deepEqual(
        result.hits.map((hit) => hit.document.id),
        [documents.get(item.gold)!.id],
      );
      assert.equal(result.hits[0]!.lexicalRank, undefined);
      assert.equal(result.hits[0]!.denseRank, 1);
      assert.equal(
        result.bundle.images[0]!.blobHash,
        documents.get(item.gold)!.images[0]!.blobHash,
      );
      denseRows.push({
        recall: Number(
          result.hits.some(
            (hit) => hit.document.id === documents.get(item.gold)!.id,
          ),
        ),
        imageRecall: Number(
          result.bundle.images.some(
            (image) =>
              image.sourceId === documents.get(item.gold)!.id &&
              image.blobHash === documents.get(item.gold)!.images[0]!.blobHash,
          ),
        ),
      });
    }
    // Hint-only discovery: description must never become authoritative evidence.
    const original = documents.get("isr")!;
    const image = original.images[0]!;
    const query = "violetbridge";
    const description = `${query} fabricated synthetic diagram description`;
    await assert.rejects(
      runtime.search(query, 5),
      /No relevant evidence found/,
    );
    const hint = createVisionHint(original, {
      documentId: original.id,
      revision: original.revision,
      sourceHash: original.sourceHash,
      imageId: image.id,
      blobHash: image.blobHash,
      description,
      modelFingerprint: sha256("offline-fixture-model"),
      promptFingerprint: sha256("offline-fixture-prompt"),
    });
    await SqliteCatalog.use(runtime.root, async (catalog) =>
      catalog.saveHint(hint, catalog.epoch()),
    );
    const hinted = await reopened.search(query, 5);
    assert.deepEqual(
      hinted.hits.map((hit) => hit.document.id),
      [original.id],
    );
    assert.equal(hinted.bundle.texts[0]!.text, original.elements[0]!.text);
    assert.equal(hinted.bundle.images[0]!.blobHash, image.blobHash);
    assert.equal(hinted.bundle.images[0]!.originKind, image.originKind);
    assert.deepEqual(await runtime.blobs.get(image.blobHash), diagram(6));
    assert.ok(!JSON.stringify(hinted).includes(description));
    const imageRows = rows.filter((row) => row.imageRecall !== null);
    return {
      rows,
      lexicalRecallAt5:
        rows.reduce((sum, row) => sum + row.recall, 0) / rows.length,
      imageRecallAt5:
        imageRows.reduce((sum, row) => sum + row.imageRecall!, 0) /
        imageRows.length,
      fakeDenseOnly: {
        queries: denseRows.length,
        recallAt5:
          denseRows.reduce((sum, row) => sum + row.recall, 0) /
          denseRows.length,
        imageRecallAt5:
          denseRows.reduce((sum, row) => sum + row.imageRecall, 0) /
          denseRows.length,
      },
      hintOnly: {
        queries: 1,
        recallAt5: Number(
          hinted.hits.some((hit) => hit.document.id === original.id),
        ),
        imageRecallAt5: Number(
          hinted.bundle.images.some(
            (item) =>
              item.sourceId === original.id && item.blobHash === image.blobHash,
          ),
        ),
        originalAuthority: true,
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("offline synthetic retrieval baseline is reproducible across fresh catalogs", async (context) => {
  const first = await evaluate();
  const second = await evaluate();
  assert.deepEqual(
    second,
    first,
    "fresh paths/catalogs must reproduce measured metrics",
  );
  assert.equal(first.lexicalRecallAt5, 1);
  assert.equal(first.imageRecallAt5, 1);
  context.diagnostic(JSON.stringify(first));
});

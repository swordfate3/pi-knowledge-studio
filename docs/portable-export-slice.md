# V2 第一小步：原图证据离线导出

状态：**实验性代码已实现；不是完整 P1，也不是完整 RAG**。现有 Pi 工具仍使用 v1；本模块不自动读取或迁移旧 collection。无新依赖，无模型调用，无网络访问。

## 已实现

- `src/domain/evidence.ts`：版本化证据、文字片段、图片出现位置、受限文档 AST。
- `src/ports/blob-store.ts`：只接受字节/hash 的资产接口。
- `src/adapters/blob/file-blob-store.ts`：SHA-256 内容寻址存储，临时文件完成后使用独占 hard link 发布；同字节去重，读取与重复写入均核验 hash。
- `src/application/validate-evidence.ts`：ID、来源、片段 hash、UTF-16 偏移、图像来源分类和文档引用校验。
- `src/adapters/export/portable-export.ts`：冻结输入、只导出选择的证据与图片、生成安全转义的 Markdown/HTML、资源与 hash manifest；完成后 rename 发布到自动命名的独立子目录。
- `src/adapters/export/png.ts`：首版显示门禁只支持 CRC 校验通过的 8-bit、非交错、非调色板、非动画 PNG；像素上限 400 万、单图 20 MiB、导出图片合计 50 MiB。拒绝其他格式，不静默转换。

输出：

```text
<approved-output-root>/document-<uuid>/
  document.html
  document.md
  assets/<sha256>.png
  sources.json
  evidence.json
  manifest.json
```

`manifest.json` 校验其他文件，不包含自身。相同字节仅保存一个文件，但不同 occurrence 保留独立来源位置及 original/crop 分类。

## 调用方式（内部 TypeScript API）

```ts
import { FileBlobStore } from "./src/adapters/blob/file-blob-store.ts";
import { exportPortableDocument } from "./src/adapters/export/portable-export.ts";

const blobs = new FileBlobStore(approvedNewBlobDirectory);
const hash = await blobs.put(approvedPngBytes);
// 用 hash 构造 ImageOccurrence；bundle 中的 textHash 对应精确 UTF-8 片段。
// 手动选择 bundle 和 document AST；不得直接信任未经审核的模型输出。
const directory = await exportPortableDocument(
  existingApprovedOutputDirectory,
  bundle,
  document,
  { documentContent: true, images: true, excerpts: true },
  blobs,
);
```

这不是 CLI；调用者负责先选定**独立且获准**的存储/输出目录，输出根必须已存在。不给它旧知识库路径。路径必须来自用户/可信宿主配置，不能来自模型或导入的文档。API 尚未实现 protected-root 清单与统一授权层。

`documentContent: true` 单独批准完整标题、正文与图注（它们本身可能含引用原文）；没有这一授权，整个导出失败。`images: true` 表示已批准所选图片再分发（含可能存在的 EXIF/其他元数据）；不默认去元数据、不假装有图片版权。`excerpts: false` 输出显式 `provenance-only`，附录/JSON 不携带原文片段。它不是内容脱敏器：正文和图注本身也需调用者审核，不能借此保证正文没有引用原文。

## 验证

```sh
npm run check
npm test
```

`tests/portable-export.test.ts` 用自制 1×1 PNG 和中文片段验证：离开数据根后资源可读、字节 hash 不变、重复图片位置不丢失、并发 blob 去重、损坏拒绝、未知引用拒绝、分享权限、HTML/Markdown 转义、symlink 拒绝、异步期间输入不变性、PNG 格式门禁。测试不等价于浏览器视觉回归或真实教材质量评测。

## 明确限制 / 下一步

1. 尚无 SQLite、Revision/ParseRun 持久化、Snapshot 发布、删除/GC或统一授权。这次只实现**手工证据 → 原图离线包**，`snapshotId` 是调用者提供的标识，不是已实现索引一致性证明。
2. 原文片段 hash 只检验片段自洽；尚未与不可变源元素存储绑定。`originKind` 由可信捕获层提供，不能由当前校验器证明 PDF 提取/裁剪的真实过程。
3. CAS/导出为本地单用户目录设计；POSIX 写入根要求当前用户所有且不允许 group/others 写入。调用者还需保证 ACL 与同用户进程可信；Windows ACL 尚未验证。不防具有同用户权限的恶意并发写入者；不提供断电 fsync durability，崩溃可能留下 staging/orphan 文件，尚无自动清理。
4. Linux 复用 descriptor-based 路径保护；其他平台的路径检查存在更弱的竞态保证，尚未进行 Windows 验收。Hard link 不可用的文件系统会明确失败，不用非原子复制降级。
5. 本轮不支持 JPEG/WebP/PDF 提取，不发送视觉/embedding请求，不提供检索或 LLM 文档生成。`model-generated` 只是来源标签，引用 ID 正确不等于语义有依据。
6. 后续优先完成 SQLite 元数据及源片段绑定、PNG/JPEG/WebP 成熟解析适配、显式输入范围检查，再接数字 PDF 和可插拔检索。

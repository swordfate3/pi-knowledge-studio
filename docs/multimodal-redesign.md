# 多模态知识库重设计提案

状态：**整体架构仍为提案；首个实验性导出切片已实现**。日期：2026-09-05。目标仓库：`pi-knowledge-studio`。下文记录初始设计与基线审查；后续实现范围见 [原图离线导出切片](portable-export-slice.md)。现有 Pi 工具仍使用 v1，未修改已安装的 `pi-knowledge`、旧知识库数据或远程模型服务。

## 1. 产品目标与非目标

输入文档或独立图片，保存可追溯的文字和原图；检索相关知识时取回相应图文证据，生成带正确原图、图注、引用的可携带 Markdown/HTML 文档包。

**成功不等于“有向量数据库”，而是“查对知识、带回正确原图、离开知识库仍可读”。**

- 模型能力独立可替换：文本 embedding、图片 embedding、视觉理解、重排、生成。
- 保留原文件、原图、解析结果及关系，索引是可重建的派生数据。
- 第一阶段面向个人、本地单用户知识库；不声称已经支持多租户服务、完整文档格式或出版级生成。
- 不默认引入 GraphRAG、Agentic RAG、ColPali、多服务平台或独立 Web UI。只有评测证明收益后再增加。
- 不绑定 FreeRTOS；领域 profile 只提供术语和写作指导。

## 2. 四路审查与代码证据

四个成功完成的只读子代理分别审查 Studio 实现、pi-knowledge 可复用性、图文资产设计、模型与检索评测。最初的 ACP delegate 通道因缺少 `@earendil-works/pi-server` 全部启动失败；更换 Agent 通道后四项任务均完成。没有修改全局 Pi 安装。

以下为审查结果，不是新功能声明。Studio 路径相对仓库根；pi-knowledge 路径相对本次检查的已安装 `pi-knowledge@0.10.0` 包根。

| 发现 | 证据 | 设计影响 |
| --- | --- | --- |
| Studio 仅子串检索，不检索保存的 vision annotations | `src/retrieval/search.ts:12–68` | 替换检索；解释结果也须有可索引表示 |
| 文字命中不会自动带回相关图片；asset-only 在混排截断后过滤 | `extensions/index.ts:244–246`、`src/retrieval/search.ts:58–68` | 引入图文关系扩展；按证据类型建候选集 |
| PDF 丢失页级定位且没有图片 | `src/ingest/source-reader.ts:176–206,249–264,397–405` | 替换富文档解析链路 |
| 显式导入未知格式可能按 UTF-8 读取，失败 PDF 可存空记录 | `src/ingest/source-reader.ts:207–213,266–305,459–465` | MIME 检测、格式路由和结构化处理状态 |
| 源文件变化形成新 ID，旧内容仍可检索 | `src/ingest/source-reader.ts:385,450–458` | 逻辑文档、源修订和活动快照分离 |
| 整体 JSON 替换并非并发事务，图像链接依赖数据目录 | `src/storage/store.ts:289–317`、`src/generation/markdown.ts:64–73` | SQLite 事务与独立导出打包 |
| pi-knowledge 根类型只暴露 Pi 扩展注册函数 | `dist/index.d.ts:30–40` | 不作为稳定引擎 SDK 依赖 |
| pi-knowledge hybrid 使用 weighted fusion，并以词法命中为门槛 | `dist/src/engine.js:1313–1330,1360–1366` | 不能误称现有实现为独立双路候选 RRF |
| 内部提供模型签名检查，但向量文件和数据库分别更新 | `dist/src/embedding/provider.js:99–109`、`dist/src/engine.js:530–538,1163–1174` | 自建不可变索引代次与活动指针 |
| pi-knowledge 的文本解析/存储没有完整原图资产模型 | `dist/src/engine.js:435–472`、`dist/src/storage/sqlite.js:9–110` | 独立图文核心；不共用现有数据目录 |

### 复用边界

保留并补测试：`src/core/path-safety.ts` 的受限读写能力、`src/core/provenance.ts` 的哈希、`src/vision/provider.ts` 的部分验证/传输、profile、Markdown 转义与证据附录思路、Pi tool 外壳。路径安全跨平台保证不同，不能仅凭 Linux 实现宣称 Windows 同等安全。

重新设计：类型、解析编排、权威存储、检索、生成与导出。字符切块和旧子串评分仅留作 fallback/评测基线。旧 JSON 仅作为只读导入源。

pi-knowledge 为 MIT，可参考或带声明复用选定代码；其内部 deep import 不构成稳定 API。未来若确有兼容需求，以独立进程、版本锁定、独立数据目录接入，默认不做。依赖及模型许可证另审。

## 3. 推荐运行架构

```text
Pi 工具 / 未来 CLI
       │
       ▼
Node / TypeScript 应用层（作业、索引、检索、导出编排）
       │
       ├── 领域契约：修订、元素、图片出现位置、证据、能力
       │       ▲
       ├── 本地 SQLite 元数据 + 内容寻址文件资产
       ├── 本地 Python 解析子进程（Docling 为首选候选适配器）
       ├── 可替换检索后端（先有界精确向量检索，后按规模引入 ANN）
       └── 模型适配器 → 本地/远程 embedding、视觉、重排、生成
```

**一个主程序、一个可选富文档解析 worker，不先拆成微服务。** 纯文本能力不强制依赖 Python。Python 负责成熟解析生态；Node 保留 Pi 集成和数据提交权。Docling 的输出需要转换成自己的契约，不能把整个领域模型绑定其内部 schema。

SQLite 负责事务、元数据、作业/outbox 和快照指针；二进制文件以 SHA-256 内容寻址。初始向量实现为可替换的有界扫描适配器，不宣称大规模性能；目标规模和 p95 延迟未确定前不强制外部向量服务。SQLite driver、Python 版本、解析器/OCR 版本通过第一阶段兼容性验证后锁定，不在本轮添加依赖。

### 目标目录（仅设计，不生成空目录）

```text
extensions/index.ts          # 薄 Pi 入口，保留 studio 命名空间
src/domain/                  # 数据与能力契约；不依赖 Pi/SQLite/HTTP
src/application/             # capture/parse/index/search/compose/export 用例
src/ports/                   # repository/parser/model/vector 接口
src/adapters/                # sqlite、blob、模型、格式、导出实现
src/composition/              # 配置、依赖组装、生命周期
workers/parser/              # 独立 pyproject + src 包，仅负责解析
contracts/                   # 跨语言 schema 与协议版本
tests/                      # fixtures/contract/integration
docs/                       # 架构、验证、迁移文档
```

依赖方向：入口 → 应用 → 领域/ports；adapters 实现 ports，由 composition 注入。领域不得反向依赖 adapters；worker 不直接写数据库。目录迁移在实施阶段进行，旧文件不一次性删除。

## 4. 图文数据契约

| 实体 | 必要字段/不变量 |
| --- | --- |
| Document | `id, collectionId, sourceKey, activeSnapshotId, deletedAt`；逻辑来源身份与内容哈希分离 |
| Revision | `id, documentId, sourceBlobHash, inputManifestHash, resources[]`；捕获主文件和侧边资源 |
| ParseRun | `id, revisionId, parserFingerprint, status, coverage, warnings`；解析升级不是源文件变化 |
| Element | `id, parseId, kind, parentId, order, text, locators[]`；标题、正文、表格、图注等 |
| Asset | `id, blobHash, verifiedMime, byteLength, dimensions`；不可变二进制，不等于文档归属 |
| AssetOccurrence | `id, parseId, elementId, assetId, locator, originKind, displayTransform`；同一图出现多次保留多条 |
| Relation | caption-of、references、nearby、section-parent；记录来源、置信度；相邻不等于支持 |
| AssetDerivation | 输出资产、输入引用、操作、参数、工具版本；无环依赖 |
| RetrievalRepresentation | evidence refs、payload hash、类型、producer fingerprint；切块/描述不是权威原文 |
| IndexGeneration | 语料快照、解析/切块/分词版本、embedding space、状态、覆盖率 |
| Snapshot | 不可变映射：document→revision/parse、representation集合、lexical/vector generations、query embedding配置、publication epoch |
| EvidenceBundle | 查询、固定快照、来源片段、图像 occurrence、得分、警告；只含授权证据 |
| GeneratedDoc | evidence bundle、生成配置、受限内容 AST、引用映射、输出 manifest |

### 不可妥协的原图规则

`originKind` 至少区分：`standalone_original / embedded_original / decoded_embedded / page_render / page_crop`。

- 可准确恢复的资源保存原字节；解码、裁剪、合成、缩放不冒充字节原图。
- PDF 矢量图可渲染裁剪，保存源页及坐标、旋转/变换、渲染参数和派生链。
- 同一资产可被多个 occurrence 引用；去重字节不去重出现位置和图注。
- OCR、视觉解释单独记录模型、提示模板、版本；可检索，但不作为原文引用。
- Markdown/HTML 的关联图片变化也改变 `inputManifestHash`；否则正文未变时图片更新会被漏掉。
- PDF 采用 1-based 页码、可选印刷页标签和标准化坐标；DOCX 用结构锚点，不虚构稳定页码；文本用行/字符范围。

## 5. 解析与数据生命周期

### 格式交付顺序

| 阶段 | 范围 | 验收重点 |
| --- | --- | --- |
| 第一闭环 | Markdown/TXT、数字 PDF、独立 PNG/JPEG/WebP | 正文、图注、原图/裁图区分、来源、离线导出 |
| 第二波 | 扫描 PDF、DOCX、静态本地 HTML | OCR 状态、Office 原始资源、结构锚点、HTML 安全 |
| 后续 | PPTX、XLSX、EPUB、网页采集、复杂公式表格 | 按格式独立 fixture 验收；不宣称统一无损 |

这是分期，不是放弃广泛文档。加密、损坏、未支持、低质量解析分别报告；不把空文本导入算成功。

### Worker 协议

请求含 `protocolVersion, jobId, revisionId, stagedInputHandle, resourceManifest, parserConfig, budgets`；结果含 `status, elements, occurrences, derivations, artifactManifest, coverage, warnings`。

只传本次暂存输入，产物只允许相对路径；Node 重新校验长度、哈希、MIME、引用和坐标后提交。stdout 仅协议、stderr 为脱敏日志，支持流式/文件 manifest，避免把整本文档和图片塞进一个巨大 JSON。真正取消须终止对应子进程；Promise 超时不等于解析已停止。

### 幂等、提交、删除

1. 捕获不可变源快照和资源 manifest，以 `(documentId,inputManifestHash)` 去重。
2. 解析按 `(revisionId,parserFingerprint)` 建作业，输出私有 staging。
3. 验证后先落不可变 blob，再事务发布元数据；崩溃留下的孤立 blob 可延后回收，不允许元数据指向未完成文件。
4. 索引在新 generation 构建，SQL 与外部向量后端不伪装成共同事务；outbox 驱动，完成验证才切活动快照。
5. 每个查询固定一个 Snapshot，连同 query embedding 配置一起持有到检索结束，禁止中途跟随全局模型切换。发布采用预期 epoch 的条件更新，已被更新/reindex 取代的作业即使最后完成也不得覆盖新快照。旧快照保持可查直至切换；明确批准的 partial 模式必须显示覆盖率。
6. 删除先 tombstone，检索与取证均检查活动快照/删除 epoch；过期作业不得复活已删除内容。
7. GC 计算保留修订、运行作业及输出引用；先计划再确认。外部已导出的副本无法远程撤销。

## 6. 模型接入与向量空间

五种能力独立声明和验证，不按名称猜测：`embedText / embedImage / describeImage / rerank / generate`。记录 declared/verified/unknown、验证日期、输入模态、协议、批大小、字符/token/字节上限、模型版本、隐私策略。

所有调用接受取消信号、超时、请求预算和调用级配置；不在执行中重新读取全局环境改变模型身份。返回值必须验证 schema、数量、向量长度与有限数值。429/短暂错误有限次退避；认证/schema 错误立即失败；不静默换供应商。

`embeddingSpaceId` 包含：适配器语义、模型 ID/不可变 revision、维度、模态/对齐空间、query/document 指令、预处理、归一化和距离度量。**维度相同不代表向量可混用。** 解析/切块/分词版本另纳入 index manifest。未知模型 revision 显示复现限制；切模型影子重建、评测后原子切换，保留回滚代次。

### 已有远程服务如何利用

仅为之前检查的快照，不代表本轮重新验证健康：

- WeMM：已验证文字接口 `POST /embed`，不是标准 `/v1/embeddings`。`texts` 1–32，每项 ≤32768 字符；`dimension` 显式选 256/512/1024/2560。检查 `model_id/model_revision/dimension/normalized/embeddings`。字符限制不能当模型 token 限制，超长按来源可追溯切分，不静默截断。当前接口不能发送图片。
- Qwen：仅 completion 宣告已知；实际生成行为和视觉输入支持仍需契约/样例验证。不能据模型名字认定可看图。
- 没有已验证的图像 embedding 或 reranker；不假装所有分支就绪。
- 私有主机/端口放未跟踪的部署配置，仓库不保存密钥或远程操作脚本。

用户已允许必要的远程模型验证和下载，不等于允许停止服务，也不等于可以任意发送私人资料。先用自制/公开许可 fixture、设预算；真实文档按目的地/模态确认发送范围。新模型先核验许可证、运行时、磁盘，再注册服务并重新执行显存/利用率门禁；不能根据历史显存快照启动。

## 7. 检索：先可靠，再复杂

```text
查询 + 集合/版本过滤
  ├─ 中文感知 BM25（正文、图注、标识符、可追溯描述）
  └─ 稠密文字检索（匹配 embedding space）
        → 独立候选并集 → RRF → 可选重排
        → 去重/多样性 → 章节和图文关系扩展 → 固定 EvidenceBundle
        → 受限生成 → 引用和图片校验 → 可携带导出
```

- BM25 无结果仍运行向量支路；不强制词法证据门槛。dense 无法运行时明确报告 lexical-only。
- 首版实验默认每路 top50、RRF `k=60`、重排最多30、证据最多10、图片候选最多5；均是待调参的有界起点，不是质量结论。
- 先按 element/occurrence 合并不同 representation，避免 OCR/描述重复占满结果。图片检索单独 top-k，不先截断混合结果。
- 原图通过 caption/引用/正文关系取回；没有直接图片 embedding 也能生成带原图的文档，但纯视觉语义召回会受限。
- 中文不能直接假设 FTS5 `unicode61` 能合理分词。首轮比较显式中文分词与字符 n-gram，同时保留 `vTaskDelay` 等完整标识符。分词规则和词典必须版本化。FTS5 trigram 对不足3字符的全文查询不匹配，不能独自承担“任务”等短词。
- 图像向量、页面 multi-vector、查询改写和图谱是后续可选路线，须在 figure recall/延迟/成本上证明收益。

## 8. 有证据的生成与导出

模型只输出受限文档 AST，例如 `paragraph(text,evidenceIds[])`、`figure(occurrenceId,renditionChoice,caption,evidenceIds[])`。不允许生成任意文件路径或外链来插图。

应用验证所有 ID 属于 frozen bundle 和当前授权集合，引用可解析；原文摘引可用 offset 确定性生成。语义支持仍需独立评测，ID 正确不意味着结论正确。找不到证据时明确缺口，不拿无关图凑数。无可用生成模型时可输出标记为证据汇编的确定性文档，但不能称为生成模型验收通过。

```text
export/
  document.md
  document.html
  assets/<sha256>.<verified-extension>
  sources.json
  evidence.json
```

`evidence.json` 默认携带本次引用的最小原文片段、元素/字符范围、片段 hash 及来源映射，让读者离线检查“文档引用了什么”；不自动复制整本书。若分享权限不允许携带片段，导出显式标记 `provenance-only`，仅保证来源身份可追溯，不得称为自包含证据验证。即便有片段，源文件 hash 也不能在缺少原文件时独立证明摘录未被篡改；完整原件真实性核验需要另行获准附源文件或访问可信来源。

导出前核验资产 hash，复制选中的真实字节或明确标注的安全派生图；本地相对链接。`sources.json` 含公开来源标签、revision hash、页/区域/锚点、occurrence、originKind、导出 hash。默认不暴露内部绝对路径，不自动附整本原文件。

HTML 用白名单 AST 渲染、转义、禁止活动内容、限制 URL 与 CSP，无必需外网资源。SVG 等原始文件可保留作下载，但展示使用受控安全派生物。原图可能含 EXIF 等隐私；提供原字节与去元数据派生版本的明确选择，不能偷偷覆盖原图。版权/再分发权限在分享前检查。

## 9. 安全边界

- 输入/解析/模型输出全视为不可信；文档中的“指令”不能执行工具、改变策略、指定文件路径。
- 目录导入先列 scope 和排除计划；限制总文件数、总字节、单文件/页数、解压比、像素和 CPU/内存/时间。
- worker 目标为无特权、无秘密、禁网络、只读输入。普通子进程本身不是完整沙箱；实际隔离机制须经过宿主验证，否则报告能力缺口并限制不可信格式。
- 校验 symlink/traversal、驱动器/UNC、archive entry 和 worker artifact 路径；敏感文件默认不采集。
- 出站端点允许列表，拒绝未验证重定向，日志不含原文或密钥；远程 embedding、视觉、重排、生成分别可禁用。
- 不读写现有 FreeRTOS KB；所有开发 fixture、索引、输出使用独立数据根且不提交。

## 10. 决策与尚待验证

采用：现仓库内重构、独立图文核心、SQLite+内容寻址资产、Node+Python parser、模型能力契约、双路融合、原图导出验证、只读 v1 迁移。

待验证而非反复要求用户选技术：SQLite driver/中文分词、Docling 锁定版本及原图保真、向量后端的规模阈值、WeMM 维度、Qwen 视觉能力、重排模型、宿主 worker 隔离。

需要用户决定的产品/数据事项：优先资料格式、典型文档规模、真实资料出站范围、共享/版权边界。可先用合成 fixture 开始，不必等所有高级模型齐备。

实施顺序和数值验收见 [重构验收计划](redesign-validation.md)。直观总览见 [架构图解](multimodal-redesign.html)。

## 11. 公开依据与限制

2026-09-05 复核的官方资料；说明能力存在，不等于本项目完成集成或效果保证：

1. [Docling 图像导出示例](https://docling-project.github.io/docling/_generated/examples/export_figures/)：page/figure/table 图像及 referenced/embedded Markdown/HTML；渲染产物不自动等于原字节。
2. [LangChain 多模态 RAG](https://www.langchain.com/blog/semi-structured-multi-modal-rag)：检索表示与原始对象分离、图片描述检索后取回原图；较早的架构文章，不作为最新模型选型。
3. [LlamaIndex multimodal RAG](https://www.llamaindex.ai/blog/multimodal-rag-in-llamacloud)：文字/图片节点检索并用于生成；不等于提供本方案的离线文档包。
4. [SQLite FTS5](https://www.sqlite.org/fts5.html)：BM25、tokenizer 和 trigram 限制；中文分词需额外设计。
5. [Qdrant Hybrid Queries](https://qdrant.tech/documentation/search/hybrid-queries/)：多路 prefetch、融合和多阶段查询；只是可选后端参考，不是首版必装服务。
6. [ColPali](https://github.com/illuin-tech/colpali)：视觉页面 late interaction 检索路线；不替代图片资产抽取和导出。

# Configuration

Knowledge Studio reads deployment configuration from the host environment when `extensions/index.ts` registers. There is no committed secret configuration file and tool arguments cannot override endpoints or credentials.

## Storage and approvals

| Variable | Purpose | Default |
| --- | --- | --- |
| `PI_KS_V2_DATA_DIR` | Absolute private runtime root | `~/.pi/knowledge-studio/` |
| `PI_KS_V2_HEADLESS_GRANTS` | Comma-separated headless capability allowlist; explicit `all` enables every capability | deny all |
| `PI_KS_V2_PDF_MAX_INPUT_BYTES` | Durable-PDF source quota | implementation default |
| `PI_KS_V2_PDF_MAX_STORAGE_BYTES` | Durable-PDF storage quota | implementation default |
| `PI_KS_V2_OCR_CONFIG` | Host-approved OCR configuration | unset |

`PI_KS_V2_*` is retained as a compatibility-stable configuration namespace. It does not enable or refer to another bundled implementation.

## Optional model adapters

Configuration families are:

- `PI_KS_V2_EMBED_*` — embedding endpoint, adapter kind, model/revision/dimension, instructions, optional key.
- `PI_KS_V2_RERANK_*` — reranking endpoint, model/revision, timeout, optional key.
- `PI_KS_V2_GENERATE_*` — generation endpoint/model, timeout, optional key, and pinned generation controls.
- `PI_KS_V2_VISION_*` — vision endpoint/model/revision, timeout, and optional key.
- `PI_KS_PROFILE_*` — credential environment references used by immutable PDF model profiles; never put raw keys in profile records.

Endpoints, accepted values, deadlines, and disclosure behavior are specified in [`../docs/usage.md`](../docs/usage.md). Invalid or incomplete model configuration fails closed; there are no default remote endpoints, implicit credential fallbacks, automatic downloads, or silent model switches.

## Removed V1 configuration

The old `PI_KNOWLEDGE_STUDIO_*` variables are no longer read because the V1 runtime was removed. They must not be documented or deployed as current configuration. Old JSON stores are not opened or migrated in place; see [`../docs/storage-layout.md`](../docs/storage-layout.md) before removing archived data.

## Configuration hygiene

Use an untracked environment or process manager. Never commit API keys, `.env` files, private documents, generated collections, downloaded models, or machine-specific book paths. Apply least-privilege grants and private filesystem permissions; ignore rules are not a security boundary. `PI_KS_V2_HEADLESS_GRANTS=all` intentionally disables the extension's capability prompts at startup; use only for a fully trusted local process.

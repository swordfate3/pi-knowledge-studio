# Tests

Tests should remain separate from implementation and distinguish unit, integration, and end-to-end coverage. The package's validation commands are:

```sh
npm run check
npm test
```

`npm run check` runs strict TypeScript validation. `npm test` runs `tests/*.test.ts` with Node's type stripping. These commands validate the available code paths; they do not prove embedding/BM25 behavior, complete PDF OCR, external vision availability, or publication-quality Markdown.

Add tests for profiles, chunking/lexical scoring, provenance and safe collection storage, supported ingest formats, asset-copy limits, Markdown citations, and vision error handling. Keep fixtures synthetic and free of credentials, private documents, book paths, or other sensitive material. Do not commit generated collections or downloaded model data.

## Real Pi smoke tests

```sh
node --experimental-strip-types --test tests/package-manifest.test.ts tests/pi-e2e-smoke.test.ts
# Select a particular host installation rather than the local development Pi:
PI_KS_PI_CLI=/absolute/path/to/pi/dist/bundle/cli.js node --experimental-strip-types --test tests/pi-e2e-smoke.test.ts
```

The shared resolver locates Pi without importing/executing its CLI: first the local `@earendil-works/pi-coding-agent` manifest's `bin.pi`, then a `pi` JS entry on `PATH` (following symlinks, including `~/.local/bin/pi`). Host-only `PI_KS_PI_CLI` overrides discovery and must point to a readable JS entry runnable by `process.execPath`; shell wrappers/native binaries are not supported. An explicit invalid/empty override **fails**, never skips or falls back. Only missing default discovery may skip the real-RPC cases, with a reason; that is not an execution acceptance pass. Tests pass the selected path to their child process so selection cannot drift. The override is not forwarded to Pi's isolated environment or exposed as a tool argument.

Synthetic resolver tests do not start Pi. The real-RPC cases start Pi with isolated temporary state and deterministic loopback model transport, covering extension loading, lifecycle/recovery, permission denials and generation controls; they do not prove live-model quality or human TUI approval. `--live` is a separate opt-in script mode, not used by this test command.

Manifest contract tests keep host packages out of runtime/optional/bundled dependencies, require wildcard peers for actual host value imports, and check extension entry and lock-root consistency. `typebox` remains a dev dependency so native Node tests can resolve it; the running extension uses Pi's copy. A separately installed Pi package checkout must be updated independently of this source checkout and reloaded.

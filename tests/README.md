# Tests

Tests should remain separate from implementation and distinguish unit, integration, and end-to-end coverage. The package's validation commands are:

```sh
npm run check
npm test
```

`npm run check` runs strict TypeScript validation. `npm test` runs `tests/*.test.ts` with Node's type stripping. These commands validate the available code paths; they do not prove embedding/BM25 behavior, complete PDF OCR, external vision availability, or publication-quality Markdown.

Add tests for profiles, chunking/lexical scoring, provenance and safe collection storage, supported ingest formats, asset-copy limits, Markdown citations, and vision error handling. Keep fixtures synthetic and free of credentials, private documents, book paths, or other sensitive material. Do not commit generated collections or downloaded model data.

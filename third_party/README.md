# Third-party boundaries

The package core is dependency-light and runs on Node.js `>=22.19.0`. Keep optional integrations explicit and document their source, version, license, data flow, and failure behavior before adding them.

The MVP has two notable optional boundaries:

- PDF text extraction dynamically uses `unpdf` when available; missing support produces a warning. This is not complete PDF OCR or layout parsing.
- Vision sends selected image bytes to an OpenAI-compatible endpoint configured through environment variables. Treat that endpoint as an outbound privacy boundary and never commit its credential.

Do not add vendor- or board-specific dependencies merely because the optional FreeRTOS / STM32 example profile exists. Do not package downloaded models, private source material, credentials, PDFs/DOCX/EPUB books, or generated collection data. Record any future third-party addition in `DECISIONS.md` and verify its license before release.

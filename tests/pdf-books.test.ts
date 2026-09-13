import assert from "node:assert/strict";
import test from "node:test";
import { PdfBookCatalog } from "../src/application/pdf-books.ts";
import type { ImportedPdfBookSummary } from "../src/application/pdf-generation-store.ts";
import type { PdfJobBookSummary } from "../src/application/pdf-jobs.ts";

function direct(bookId: string, title: string): PdfJobBookSummary {
  return {
    bookId,
    title,
    sourceBytes: 123,
    totalPages: 10,
    parsedPages: 10,
    state: "parsed",
    searchable: true,
  };
}

function imported(bookId: string, title: string): ImportedPdfBookSummary {
  return {
    ...direct(bookId, title),
    state: "ready",
    active: true,
    generationCount: 2,
  };
}

function source(books: PdfJobBookSummary[]) {
  return {
    async listBooks() { return books; },
    async summary(bookId: string) {
      const book = books.find(candidate => candidate.bookId === bookId);
      if (!book) throw new Error("missing");
      return book;
    },
  };
}

function generationSource(books: ImportedPdfBookSummary[]) {
  return {
    async listBooks() { return books; },
    async summary(bookId: string) {
      const book = books.find(candidate => candidate.bookId === bookId);
      if (!book) throw new Error("missing");
      return book;
    },
  };
}

test("PDF book catalog merges stores and resolves exact title, short reference, and legacy ID", async () => {
  const firstId = `book_${"a".repeat(64)}`;
  const secondId = `book_${"b".repeat(64)}`;
  const catalog = new PdfBookCatalog(
    source([direct(firstId, "FreeRTOS 内核")]),
    generationSource([imported(firstId, "ignored duplicate"), imported(secondId, "Scheduler Guide")]),
  );

  const books = await catalog.list();
  assert.deepEqual(books.map(book => ({ ref: book.ref, title: book.title, active: book.active, generations: book.generationCount })), [
    { ref: "B-aaaaaaaaaaaaaaaaaaaa", title: "FreeRTOS 内核", active: true, generations: 2 },
    { ref: "B-bbbbbbbbbbbbbbbbbbbb", title: "Scheduler Guide", active: true, generations: 2 },
  ]);
  assert.equal((await catalog.resolve("B-AAAAAAAAAAAAAAAAAAAA")).bookId, firstId);
  assert.equal((await catalog.resolve("freertos 内核")).bookId, firstId);
  assert.equal((await catalog.resolve("title:Scheduler Guide")).bookId, secondId);
  await assert.rejects(catalog.resolve("scheduler"), /PDF book not found/);
  assert.equal((await catalog.resolve(secondId)).bookId, secondId);
});

test("PDF short reference collisions fail closed and remain uniquely selectable", async () => {
  const firstId = `book_${"a".repeat(12)}0${"c".repeat(51)}`;
  const secondId = `book_${"a".repeat(12)}1${"d".repeat(51)}`;
  const catalog = new PdfBookCatalog(source([direct(firstId, "One"), direct(secondId, "Two")]));

  const books = await catalog.list();
  assert.deepEqual(books.map(book => book.ref), [`B-${firstId.slice(5, 25)}`, `B-${secondId.slice(5, 25)}`]);
  assert.equal((await catalog.resolve(`B-${firstId.slice(5)}`)).bookId, firstId);
  await assert.rejects(catalog.resolve(`B-${"a".repeat(12)}`), /Invalid PDF reference.*listed B- reference/);
});

test("PDF title resolution rejects ambiguous and unknown selectors with actionable references", async () => {
  const catalog = new PdfBookCatalog(source([
    direct(`book_${"1".repeat(64)}`, "Manual"),
    direct(`book_${"2".repeat(64)}`, "Manual"),
  ]));

  await assert.rejects(catalog.resolve("manual"), /Ambiguous PDF title.*B-11111111111111111111.*B-22222222222222222222/);
  await assert.rejects(catalog.resolve("missing"), /PDF book not found: missing/);
  await assert.rejects(catalog.resolve(""), /PDF selector must be between 1 and 512 characters/);
});

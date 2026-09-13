import { basename } from "node:path";
import type { PdfGenerations, ImportedPdfBookSummary } from "./pdf-generation-store.ts";
import type { PdfJobBookSummary, PdfJobs } from "./pdf-jobs.ts";

const BOOK_ID = /^book_[a-f0-9]{64}$/u;
const BOOK_REF = /^B-([a-f0-9]{20,64})$/iu;
const SHORT_REF_HEX = 20;
const MAX_SELECTOR_LENGTH = 512;

type PdfJobSource = Pick<PdfJobs, "listBooks" | "summary">;
type PdfGenerationSource = Pick<PdfGenerations, "listBooks" | "summary">;
type SourceBook = PdfJobBookSummary | ImportedPdfBookSummary;

export type PdfBookInfo = Readonly<{
  ref: string;
  title: string;
  state: string;
  pages: number | null;
  processedPages: number;
  searchable: boolean;
  active: boolean;
  generationCount: number;
}>;

type StoredPdfBook = PdfBookInfo & Readonly<{
  bookId: string;
  direct: boolean;
  generation: boolean;
}>;

export class PdfBookCatalog {
  private readonly jobs: PdfJobSource | undefined;
  private readonly generations: PdfGenerationSource | undefined;

  constructor(jobs?: PdfJobSource, generations?: PdfGenerationSource) {
    if (!jobs && !generations) throw new Error("PDF book catalog needs at least one source");
    this.jobs = jobs;
    this.generations = generations;
  }

  async list(signal?: AbortSignal): Promise<readonly PdfBookInfo[]> {
    return (await this.storedBooks(signal)).map(book => this.publicInfo(book));
  }

  async resolve(selector: string, signal?: AbortSignal): Promise<StoredPdfBook> {
    signal?.throwIfAborted();
    const target = selector.trim();
    if (!target || target.length > MAX_SELECTOR_LENGTH) throw new Error("PDF selector must be between 1 and 512 characters");
    if (BOOK_ID.test(target)) return this.resolveExact(target, signal);
    if (target.toLowerCase().startsWith("book_")) throw new Error("Invalid legacy PDF book ID; use a listed B-… reference or a complete book_… ID");

    const books = await this.storedBooks(signal);
    const refMatch = BOOK_REF.exec(target);
    if (/^B-/iu.test(target) && !refMatch) throw new Error("Invalid PDF reference; use a listed B- reference");
    const kind = refMatch ? "ref" : target.toLowerCase().startsWith("title:") ? "title" : "auto";
    const query = kind === "ref" ? refMatch![1]!.toLowerCase()
      : kind === "title" ? this.titleKey(target.slice("title:".length).trim())
        : this.titleKey(target);
    if (!query) throw new Error("PDF title selector cannot be empty");

    const refMatches = kind === "title" ? [] : books.filter(book => book.bookId.slice("book_".length).startsWith(query));
    const titleMatches = kind === "ref" ? [] : books.filter(book => this.titleKey(book.title) === query);
    const matches = kind === "auto" ? (refMatches.length > 0 ? refMatches : titleMatches) : [...refMatches, ...titleMatches];

    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      const refs = matches.map(book => book.ref).join(", ");
      if (kind === "ref" || /^B-/iu.test(target)) throw new Error(`Ambiguous PDF reference. Use one of: ${refs}. If necessary, use the full legacy book_... ID.`);
      throw new Error(`Ambiguous PDF title; choose one of: ${refs}`);
    }
    throw new Error(`PDF book not found: ${target}`);
  }

  private async storedBooks(signal?: AbortSignal): Promise<StoredPdfBook[]> {
    signal?.throwIfAborted();
    const byId = new Map<string, StoredPdfBook>();
    if (this.jobs) {
      for (const book of await this.jobs.listBooks(signal)) byId.set(book.bookId, this.toStored(book));
    }
    if (this.generations) {
      for (const book of await this.generations.listBooks(signal)) {
        const incoming = this.toStored(book);
        const existing = byId.get(book.bookId);
        byId.set(book.bookId, existing ? this.merge(existing, incoming) : incoming);
      }
    }
    const books = [...byId.values()]
      .sort((a, b) => Number(b.active) - Number(a.active) || this.compare(a.title, b.title) || this.compare(a.bookId, b.bookId));
    return books.map(book => ({ ...book, ref: this.uniqueRef(book.bookId, books) }));
  }

  private async resolveExact(bookId: string, signal?: AbortSignal): Promise<StoredPdfBook> {
    signal?.throwIfAborted();
    const books = await this.storedBooks(signal);
    const match = books.find(book => book.bookId === bookId);
    if (!match) throw new Error(`PDF book not found: ${bookId}`);
    return match;
  }

  private merge(primary: StoredPdfBook, secondary: StoredPdfBook): StoredPdfBook {
    return {
      ...secondary,
      ...primary,
      pages: primary.pages ?? secondary.pages,
      processedPages: Math.max(primary.processedPages, secondary.processedPages),
      searchable: primary.searchable || secondary.searchable || primary.active || secondary.active,
      active: primary.active || secondary.active,
      generationCount: Math.max(primary.generationCount, secondary.generationCount),
      direct: primary.direct || secondary.direct,
      generation: primary.generation || secondary.generation,
    };
  }

  private toStored(book: SourceBook): StoredPdfBook {
    const generation = "active" in book;
    const active = generation ? book.active : false;
    return {
      bookId: book.bookId,
      ref: this.shortRef(book.bookId),
      title: this.cleanTitle(book.title),
      state: book.state,
      pages: book.totalPages,
      processedPages: book.parsedPages,
      searchable: book.searchable || active,
      active,
      generationCount: generation ? book.generationCount : 0,
      direct: !generation,
      generation,
    };
  }

  private publicInfo(book: StoredPdfBook): PdfBookInfo {
    const { bookId: _bookId, direct: _direct, generation: _generation, ...info } = book;
    return info;
  }

  private shortRef(bookId: string, length = SHORT_REF_HEX): string {
    return `B-${bookId.slice("book_".length, "book_".length + length)}`;
  }

  private uniqueRef(bookId: string, books: readonly StoredPdfBook[]): string {
    const hex = bookId.slice("book_".length);
    let length = SHORT_REF_HEX;
    while (length < hex.length && books.some(book => book.bookId !== bookId && book.bookId.slice("book_".length).startsWith(hex.slice(0, length)))) length += 1;
    return this.shortRef(bookId, length);
  }

  private titleKey(value: string): string {
    return value.normalize("NFKC").toLowerCase();
  }

  private compare(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
  }

  private cleanTitle(value: string): string {
    const title = basename(value).replace(/[\u0000-\u001f\u007f\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/gu, " ").trim();
    return title || "Untitled PDF";
  }
}

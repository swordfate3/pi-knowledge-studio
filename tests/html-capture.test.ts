import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureLocal } from "../src/adapters/parsing/capture-local.ts";
import {
  parseHtml,
  resolveHtmlImage,
} from "../src/adapters/parsing/capture-html.ts";
import { encodePng } from "../src/adapters/export/encode-png.ts";
import { sha256 } from "../src/adapters/blob/file-blob-store.ts";
import type { BlobStore } from "../src/ports/blob-store.ts";

const png = encodePng(1, 1, 3, Buffer.from([1, 2, 3]));
function store() {
  const data = new Map<string, Uint8Array>();
  const blobs: BlobStore = {
    async put(bytes) {
      const hash = sha256(bytes);
      data.set(hash, bytes);
      return hash;
    },
    async get(hash) {
      return data.get(hash)!;
    },
  };
  return { data, blobs };
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "html-capture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "image.png"), png);
  return root;
}
test("HTML entities, Unicode chunks, structural anchors and repeated originals offline", async (t) => {
  const root = await fixture(t),
    { data, blobs } = store();
  const network = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected network");
  });
  await writeFile(
    join(root, "input.html"),
    `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><h2>A &amp; 中文 &#x1f600;</h2><p>${"😀".repeat(16000)}<img src="image.png" alt="x &amp; y"><img src="image.png"></p><ul><li>one</li><li>two</li></ul><table><tr><td>cell</td></tr></table><div><img src="image.png"></div></body></html>`,
  );
  const doc = await captureLocal(root, join(root, "input.html"), blobs);
  assert.equal(doc.elements[0]!.text, "A & 中文 😀");
  assert.ok(
    doc.elements.every(
      (e) => e.text.length <= 30000 && e.locator.kind === "anchor",
    ),
  );
  assert.equal(
    doc.elements
      .slice(1, 3)
      .map((e) => e.text)
      .join(""),
    "😀".repeat(16000),
  );
  assert.equal(doc.images.length, 3);
  assert.equal(doc.images[0]!.caption, "x & y");
  assert.equal(doc.images[0]!.elementIds.length, 2);
  assert.deepEqual(doc.images[2]!.elementIds, []);
  assert.notDeepEqual(doc.images[0]!.locator, doc.images[1]!.locator);
  assert.ok(
    doc.images.every(
      (i) => i.blobHash === sha256(png) && i.originKind === "embedded_original",
    ),
  );
  assert.deepEqual(Buffer.from(data.get(sha256(png))!), png);
  assert.equal(data.size, 2);
  assert.equal(network.mock.callCount(), 0);
});

test("HTML rejects active content, CSS, malformed markup, budgets and unsafe URLs before writes", async (t) => {
  const root = await fixture(t);
  const invalid = [
    '<script src="https://example.org/x">bad</script>',
    "<style>p{display:none}</style>",
    '<link href="x.css">',
    '<base href="/">',
    "<iframe></iframe>",
    "<object></object>",
    "<form></form>",
    '<p onclick="x">x</p>',
    '<p style="color:red">x</p>',
    '<img src="image.png" srcset="x.png 2x">',
    "<picture></picture>",
    "<svg></svg>",
    "<p><div>x</div></p>",
    "<p>x</div>",
    "<p>x",
    '<img src="image.png" src="image.png">',
    '<meta charset="latin1">',
    '<!DOCTYPE html SYSTEM "x">',
    "<?xml x?>",
    "<p>\0</p>",
    "<p>x</p><img",
    "<div>".repeat(65) + "x" + "</div>".repeat(65),
    "<p>x</p>".repeat(5001),
    "<p>" + "x".repeat(1000001) + "</p>",
    '<img src="image.png">'.repeat(101),
    ...[
      "https://example.org/x.png",
      "data:image/png,a",
      "//example.org/x.png",
      "/image.png",
      "../image.png",
      "%2e%2e/image.png",
      "%252e%252e/image.png",
      "a\\image.png",
      "image.png?x",
      "image.png#x",
      "&#47;&#47;example.org/x.png",
    ].map((src) => `<p>x<img src="${src}"></p>`),
    '<p>x<img src="image.png"><img src="missing.png"></p>',
  ];
  for (const html of invalid) {
    const { data, blobs } = store();
    await writeFile(join(root, "input.htm"), html);
    await assert.rejects(
      captureLocal(root, join(root, "input.htm"), blobs),
      Error,
      html.slice(0, 90),
    );
    assert.equal(data.size, 0);
  }
  await symlink(join(root, "image.png"), join(root, "link.png"));
  await writeFile(join(root, "input.htm"), '<img src="link.png">');
  const { data, blobs } = store();
  await assert.rejects(
    captureLocal(root, join(root, "input.htm"), blobs),
    /symlink|symbolic|Unsafe|ELOOP/i,
  );
  assert.equal(data.size, 0);
  await assert.rejects(parseHtml(Buffer.from([0xff])), /HTML parsing failed/);
  await assert.rejects(parseHtml(Buffer.alloc(20 * 1024 * 1024 + 1)), /budget/);
});

test("HTML actual capture forwards optional path policy; same resolver as preflight", async (t) => {
  const root = await fixture(t),
    { data, blobs } = store();
  const path = join(root, "input.html");
  await writeFile(path, '<img src="im%61ge.png">');
  const parsed = await parseHtml(
    await import("node:fs/promises").then((fs) => fs.readFile(path)),
  );
  assert.equal(
    resolveHtmlImage(path, parsed[0]!.images[0]!.src),
    join(root, "image.png"),
  );
  const seen: string[] = [];
  await assert.rejects(
    captureLocal(root, path, blobs, (candidate) => {
      seen.push(candidate);
      if (candidate.endsWith("image.png")) throw new Error("policy denied");
    }),
    /policy denied/,
  );
  assert.deepEqual(seen, [path, join(root, "image.png")]);
  assert.equal(data.size, 0);
});

test("HTML JPEG and static WebP occurrences preserve exact originals and PNG renditions", async (t) => {
  const root = await fixture(t),
    { data, blobs } = store();
  const sharp = (await import("sharp")).default;
  const jpeg = await sharp(png).jpeg().toBuffer(),
    webp = await sharp(png).webp().toBuffer();
  await writeFile(join(root, "image.jpg"), jpeg);
  await writeFile(join(root, "image.webp"), webp);
  await writeFile(
    join(root, "input.html"),
    '<p>colors<img src="image.jpg"><img src="image.webp"><img src="image.jpg"></p>',
  );
  const doc = await captureLocal(root, join(root, "input.html"), blobs);
  assert.deepEqual(
    doc.images.map((i) => i.blobHash),
    [sha256(jpeg), sha256(webp), sha256(jpeg)],
  );
  assert.ok(doc.images.every((i) => i.rendition));
  assert.deepEqual(Buffer.from(data.get(sha256(jpeg))!), jpeg);
  assert.deepEqual(Buffer.from(data.get(sha256(webp))!), webp);
});

test("HTML reopen, retrieval and movable original-image export remain offline", async (t) => {
  const root = await fixture(t);
  const { KnowledgeRuntime } = await import(
    "../src/application/knowledge-runtime.ts"
  );
  const { mkdir, rename, readFile } = await import("node:fs/promises");
  const source = join(root, "source"),
    data = join(root, "data"),
    output = join(root, "output");
  await mkdir(source);
  await mkdir(output);
  await writeFile(join(source, "image.png"), png);
  await writeFile(
    join(source, "input.html"),
    '<p>quartz diagram<img src="image.png"><img src="image.png"></p>',
  );
  const network = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected network");
  });
  const original = await new KnowledgeRuntime(data).ingest(
    source,
    join(source, "input.html"),
  );
  const reopened = new KnowledgeRuntime(data);
  assert.equal((await reopened.search("quartz")).bundle.images.length, 2);
  const exported = await reopened.export("quartz", output, {
    documentContent: true,
    images: true,
    excerpts: true,
  });
  const moved = join(root, "moved");
  await rename(exported, moved);
  await rm(source, { recursive: true });
  await rm(data, { recursive: true });
  assert.deepEqual(
    await readFile(
      join(moved, "assets", `${original.images[0]!.blobHash}.png`),
    ),
    png,
  );
  assert.match(await readFile(join(moved, "document.html"), "utf8"), /quartz/);
  assert.equal(network.mock.callCount(), 0);
});

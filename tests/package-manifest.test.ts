import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
const hostPackages = new Set([
  "typebox",
  ...["ai", "agent-core", "coding-agent", "tui"].map((name) => `@earendil-works/pi-${name}`),
]);
const packageName = (specifier: string) => specifier.startsWith("@")
  ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory()
    ? sources(join(directory, entry.name))
    : Promise.resolve(entry.name.endsWith(".ts") ? [join(directory, entry.name)] : [])));
  return nested.flat();
}

test("host packages are peers, never installed or bundled as extension runtime dependencies", () => {
  for (const field of ["dependencies", "optionalDependencies"]) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      assert.ok(!hostPackages.has(name), `${name} must not appear in ${field}`);
    }
  }
  for (const field of ["bundledDependencies", "bundleDependencies"]) {
    const bundled = manifest[field];
    assert.notEqual(bundled, true, `${field}: true could bundle host packages`);
    for (const name of Array.isArray(bundled) ? bundled : Object.keys(bundled ?? {})) {
      assert.ok(!hostPackages.has(name), `${name} must not appear in ${field}`);
    }
  }
  for (const name of hostPackages) {
    if (manifest.peerDependencies?.[name] !== undefined) {
      assert.equal(manifest.peerDependencies[name], "*", `${name} peer must be host-provided`);
    }
  }
  assert.equal(manifest.peerDependencies.typebox, "*");
  assert.equal(manifest.devDependencies.typebox, "^1.3.23", "Native Node tests need their own typebox");
});

test("actual runtime host imports require wildcard peers (unused host packages need not be peers)", async () => {
  const files = [...await sources(join(root, "extensions")), ...await sources(join(root, "src"))];
  const runtimeHosts = new Set<string>();
  for (const file of files) {
    const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
    const requirePeer = (specifier: string) => {
      const name = packageName(specifier);
      if (hostPackages.has(name)) runtimeHosts.add(name);
    };
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        const hasValue = !clause || (!clause.isTypeOnly && (clause.name || !bindings ||
          ts.isNamespaceImport(bindings) || bindings.elements.some((item) => !item.isTypeOnly)));
        if (hasValue) requirePeer(node.moduleSpecifier.text);
      } else if (ts.isExportDeclaration(node) && !node.isTypeOnly &&
        node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        if (!node.exportClause || !ts.isNamedExports(node.exportClause) ||
          node.exportClause.elements.some((item) => !item.isTypeOnly)) requirePeer(node.moduleSpecifier.text);
      } else if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        requirePeer(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.ok(runtimeHosts.has("typebox"), "Ensure the shipped TypeBox value import is checked");
  for (const name of runtimeHosts) assert.equal(manifest.peerDependencies?.[name], "*", `${name} needs a wildcard peer`);
});

test("packaged extension entry and lock root match the manifest", async () => {
  assert.deepEqual(manifest.pi.extensions, ["./extensions/index.ts"]);
  assert.ok(manifest.files.includes("extensions"));
  assert.ok(manifest.files.includes("src"));
  for (const entry of manifest.pi.extensions) assert.ok((await stat(join(root, entry))).isFile());
  const locked = lock.packages[""];
  for (const field of ["name", "version", "license", "engines", "dependencies", "devDependencies",
    "optionalDependencies", "peerDependencies"]) {
    assert.deepEqual(locked[field], manifest[field], `lock root ${field} differs`);
  }
  assert.equal(lock.packages["node_modules/typebox"].dev, true);
});

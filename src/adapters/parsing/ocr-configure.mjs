/** Host-only helper: run ONLY against a previously verified trusted extracted stack.
 * ldd executes trusted loader inspection; never use on untrusted binaries.
 * No downloads, installs, or environment mutation. Review pins before approval.
 */
import { realpath, readFile, writeFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, join, basename } from "node:path";
import { createHash } from "node:crypto";
const [rootArg, outputArg, tempArg] = process.argv.slice(2);
if (!rootArg || !outputArg || !tempArg)
 throw Error(
  "Usage: node ocr-configure.mjs TRUSTED_EXTRACTED_ROOT OUTPUT_JSON OWNER_ONLY_TEMP_ROOT",
 );
const root = resolve(rootArg),
 files = [];
async function pin(path, name) {
 path = await realpath(path);
 if (files.some((f) => f.name === name)) return;
 const bytes = await readFile(path);
 files.push({
  path,
  name,
  sha256: createHash("sha256").update(bytes).digest("hex"),
 });
}
for (const name of ["pdfinfo", "pdftoppm", "tesseract"]) {
 const path = join(root, "usr/bin", name);
 await pin(path, name);
 const output = execFileSync("/usr/bin/ldd", [path], {
  encoding: "utf8",
  timeout: 10000,
  maxBuffer: 65536,
  env: {
   PATH: "/usr/bin:/bin",
   LC_ALL: "C",
   LD_LIBRARY_PATH: join(root, "usr/lib/x86_64-linux-gnu"),
  },
 });
 if (output.includes("not found")) throw Error(output);
 for (const line of output.split("\n")) {
  const match = line.match(/(?:=>\s+)?(\/\S+)\s+\(/);
  if (match)
   await pin(
    match[1],
    basename(match[1]).startsWith("ld-linux")
     ? "loader"
     : line.includes("=>")
       ? line.trim().split(/\s+/)[0]
       : basename(match[1]),
   );
 }
}
for (const lang of ["eng", "chi_sim"])
 await pin(
  join(root, "usr/share/tesseract-ocr/5/tessdata", lang + ".traineddata"),
  lang + ".traineddata",
 );
await pin(
 join(root, "usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"),
 "fallback-font.ttc",
);
const tempRoot = await realpath(tempArg),
 info = await stat(tempRoot);
if (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o077)
 throw Error("Temp root must be owner-only");
await writeFile(
 resolve(outputArg),
 JSON.stringify(
  { version: 1, platform: "linux-x64", tempRoot, files },
  null,
  2,
 ) + "\n",
 { flag: "wx", mode: 0o600 },
);

#!/usr/bin/env node
// Host-operated only. No Pi tool registration or permission changes.
import { verifyCollection } from "../src/application/verify-collection.ts";
const args = process.argv.slice(2);
if (args.length !== 3 || args[0] !== "--offline" || args[1] !== "--root") {
  console.error("Usage: node --experimental-strip-types scripts/verify-collection.mjs --offline --root /absolute/collection/root");
  process.exitCode = 2;
} else {
  const report = await verifyCollection(args[2], { offline: true });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === "passed" ? 0 : report.status === "incomplete" ? 2 : 1;
}

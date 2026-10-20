// Release-notes gate & extractor (2026-10-20 ruling: every release ships
// with a GitHub Release — title vX.Y.Z + notes). The notes live in
// CHANGELOG.md as a per-version section; this script is the CI hard gate:
//
//   bun run scripts/changelog.mjs gate    <X.Y.Z>   exit 1 = missing/empty
//   bun run scripts/changelog.mjs extract <X.Y.Z> [outfile]
//                                             print (or write) the section body
//
// Section format: `## [X.Y.Z]` (optionally followed by a date), body = lines
// up to the next `## ` heading. `## [Unreleased]` never satisfies a version
// gate — it must be renamed to the tagged version before the tag is pushed.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [cmd, version, outFile] = process.argv.slice(2);
if (!["gate", "extract"].includes(cmd) || !/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("usage: changelog.mjs gate|extract <X.Y.Z> [outfile]");
  process.exit(2);
}

const lines = readFileSync(join(import.meta.dir, "..", "CHANGELOG.md"), "utf8").split("\n");
let out; // undefined = not inside the target section yet
for (const line of lines) {
  if (line.startsWith("## ")) {
    const m = line.match(/^## \[([^\]]+)\]/);
    if (m !== null && m[1] === version) {
      out = [];
    } else if (out !== undefined) {
      break; // next top-level heading ends the section
    }
  } else if (out !== undefined) {
    out.push(line);
  }
}

if (out === undefined || out.join("").trim() === "") {
  console.error(
    `changelog gate FAIL: no non-empty section ## [${version}] in CHANGELOG.md — ` +
      `every release needs notes (move ## [Unreleased] to ## [${version}] - <date> before tagging)`,
  );
  process.exit(1);
}

const body = out.join("\n").trim() + "\n";
if (cmd === "gate") {
  console.log(`changelog gate PASS for ${version} (${body.length} chars)`);
} else {
  if (outFile !== undefined) {
    writeFileSync(outFile, body);
  } else {
    process.stdout.write(body);
  }
}

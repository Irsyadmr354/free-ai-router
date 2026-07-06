#!/usr/bin/env node
/**
 * scripts/check-syntax.js
 * Runs `node --check` on every .js file in the project (excluding
 * node_modules), so syntax errors are caught before commit/deploy without
 * needing a full test suite or CI (GitHub Actions CI is disabled for this
 * repo — see ROADMAP.md). Usable as a local pre-commit hook:
 *
 *   npm run check
 *
 * Exits non-zero if any file fails to parse, and prints every failure
 * found (doesn't stop at the first one) so all problems can be fixed in
 * one pass.
 */

import { execFileSync } from "child_process";
import { readdirSync, statSync } from "fs";
import { join, relative } from "path";

const ROOT = process.cwd();
const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build"]);

function collectJsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectJsFiles(full, out);
    } else if (entry.endsWith(".js") && !entry.endsWith(".min.js")) {
      out.push(full);
    }
  }
  return out;
}

const files = collectJsFiles(ROOT);
let failures = 0;

for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (err) {
    failures++;
    const rel = relative(ROOT, file);
    const stderr = err.stderr ? err.stderr.toString() : String(err.message);
    console.error(`\n❌ ${rel}\n${stderr.trim()}`);
  }
}

console.log(`\nChecked ${files.length} file(s).`);

if (failures) {
  console.error(`${failures} file(s) failed syntax check.`);
  process.exit(1);
} else {
  console.log("All files passed syntax check.");
}

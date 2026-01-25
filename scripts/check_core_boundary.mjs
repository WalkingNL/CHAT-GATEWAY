#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const CORE_DIR = path.resolve("src/core");
const IMPORT_RE = /(?:from|require\(|import\()\s*["'][^"']*integrations[^"']*["']/;

function isCodeFile(filePath) {
  return filePath.endsWith(".ts") || filePath.endsWith(".tsx") || filePath.endsWith(".mts");
}

function scanFile(filePath, violations) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.split(/\r?\n/);
  lines.forEach((line, idx) => {
    if (!line.includes("integrations")) return;
    if (!IMPORT_RE.test(line)) return;
    violations.push({
      file: filePath,
      line: idx + 1,
      text: line.trim(),
    });
  });
}

function scanDir(dirPath, violations) {
  if (!fs.existsSync(dirPath)) return;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      scanDir(fullPath, violations);
      continue;
    }
    if (!entry.isFile() || !isCodeFile(fullPath)) continue;
    scanFile(fullPath, violations);
  }
}

function main() {
  if (!fs.existsSync(CORE_DIR)) {
    console.error("[core-boundary][FAIL] missing src/core directory");
    process.exit(1);
  }
  const violations = [];
  scanDir(CORE_DIR, violations);
  if (!violations.length) {
    console.log("[core-boundary][OK] no core->integrations imports detected");
    return;
  }
  console.error("[core-boundary][FAIL] core imports integrations:");
  for (const v of violations) {
    console.error(`- ${v.file}:${v.line} ${v.text}`);
  }
  process.exit(1);
}

main();

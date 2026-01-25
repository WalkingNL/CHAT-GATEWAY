#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve("src", "core");
const ALLOWED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
const BAD_SPEC_RE = /(^|[\\/])integrations([\\/]|$)/;
const STATIC_IMPORT_RE = /\b(?:import|export)\b[^"']*["']([^"']+)["']/g;
const REQUIRE_RE = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full));
    } else if (entry.isFile() && ALLOWED_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

function extractSpecs(line) {
  const specs = [];
  for (const re of [STATIC_IMPORT_RE, REQUIRE_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    for (const match of line.matchAll(re)) {
      specs.push(match[1]);
    }
  }
  return specs;
}

function lineHasBadImport(line) {
  if (!line.includes("integrations")) return false;
  const specs = extractSpecs(line);
  if (!specs.length) return false;
  return specs.some(spec => BAD_SPEC_RE.test(spec));
}

function main() {
  if (!fs.existsSync(ROOT)) {
    console.error(`[core-boundary] missing src/core at ${ROOT}`);
    process.exit(2);
  }
  const files = listFiles(ROOT);
  const violations = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf-8").split("\n");
    lines.forEach((line, idx) => {
      if (lineHasBadImport(line)) {
        violations.push(`${path.relative(process.cwd(), file)}:${idx + 1} ${line.trim()}`);
      }
    });
  }
  if (violations.length) {
    console.error("[core-boundary] core must not import integrations modules:");
    violations.forEach(v => console.error(`  - ${v}`));
    process.exit(1);
  }
  console.log("[core-boundary] ok");
}

main();

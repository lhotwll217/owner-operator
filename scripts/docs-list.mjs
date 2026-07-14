#!/usr/bin/env node
// Lists every docs page with its routing frontmatter (summary, read_when).
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docs");

function extractMetadata(fullPath) {
  const content = readFileSync(fullPath, "utf8");
  if (!content.startsWith("---")) return { error: "missing frontmatter" };
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { error: "unterminated frontmatter" };

  let summary = null;
  const readWhen = [];
  let collecting = false;
  for (const rawLine of content.slice(3, end).split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("summary:")) {
      summary = line.slice("summary:".length).trim().replace(/^['"]|['"]$/g, "");
      collecting = false;
    } else if (line.startsWith("read_when:")) {
      collecting = true;
    } else if (collecting && line.startsWith("- ")) {
      readWhen.push(line.slice(2).trim());
    } else if (line !== "") {
      collecting = false;
    }
  }
  if (!summary) return { error: "summary missing" };
  return { summary, readWhen };
}

const pages = readdirSync(DOCS_DIR)
  .filter((name) => name.endsWith(".md") && name !== "AGENTS.md")
  .sort();

for (const name of pages) {
  const { summary, readWhen, error } = extractMetadata(join(DOCS_DIR, name));
  if (error) {
    console.log(`docs/${name} - [${error}]`);
    continue;
  }
  console.log(`docs/${name} - ${summary}`);
  if (readWhen.length > 0) console.log(`  Read when: ${readWhen.join("; ")}`);
}

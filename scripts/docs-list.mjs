#!/usr/bin/env node
// Lists every docs page with its routing frontmatter and fails if any page is
// missing title, summary, or read_when. AGENTS.md files are rules, not pages.
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docs");

function extractMetadata(fullPath) {
  const content = readFileSync(fullPath, "utf8");
  if (!content.startsWith("---")) return { error: "missing frontmatter" };
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { error: "unterminated frontmatter" };

  let title = null;
  let summary = null;
  const readWhen = [];
  let collecting = false;
  for (const rawLine of content.slice(3, end).split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("title:")) {
      title = line.slice("title:".length).trim().replace(/^['"]|['"]$/g, "");
      collecting = false;
    } else if (line.startsWith("summary:")) {
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
  if (!title) return { error: "title missing" };
  if (!summary) return { error: "summary missing" };
  if (readWhen.length === 0) return { error: "read_when missing or empty" };
  return { title, summary, readWhen };
}

const pages = readdirSync(DOCS_DIR)
  .filter((name) => name.endsWith(".md") && name !== "AGENTS.md")
  .sort();

let failed = false;
for (const name of pages) {
  const { summary, readWhen, error } = extractMetadata(join(DOCS_DIR, name));
  if (error) {
    console.error(`docs/${name} - INVALID: ${error}`);
    failed = true;
    continue;
  }
  console.log(`docs/${name} - ${summary}`);
  console.log(`  Read when: ${readWhen.join("; ")}`);
}
process.exit(failed ? 1 : 0);

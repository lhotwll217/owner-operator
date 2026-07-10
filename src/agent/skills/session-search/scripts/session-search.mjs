#!/usr/bin/env node
// Owner Operator policy wrapper around the vendored session-grep primitive.
// This helper is invoked by the session-search skill through Pi's native bash tool.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadBlacklist, isBlacklisted, pathSlugs } from "../../../../../packages/core/src/blacklist.mjs";
import { loadSessionSources } from "../../../../../packages/core/src/session-sources.mjs";
import { firstCwdFromFile, resolveRepo } from "../../../../../packages/core/src/session-cwd.mjs";

const skillDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const primitive = path.join(skillDir, "vendor", "session-grep", "session-grep.mjs");
const ooHome = process.env.OO_HOME ?? path.join(os.homedir(), ".owner-operator");
const input = process.argv.slice(2);

let ownerOperator = false;
let targetType = "all";
let json = false;
let limit = 20;
let maxChars = 8_000;
let targetRoot = null;
const passthrough = [];
for (let index = 0; index < input.length; index += 1) {
  const arg = input[index];
  if (arg === "--owner-operator") ownerOperator = true;
  else if (arg === "--target-type") targetType = takeValue(arg, ++index);
  else if (arg === "--target-root") targetRoot = takeValue(arg, ++index);
  else if (arg === "--limit") limit = Number(takeValue(arg, ++index));
  else if (arg === "--max-chars") maxChars = Number(takeValue(arg, ++index));
  else if (["--query", "--skim", "--since", "--before", "--after"].includes(arg)) {
    passthrough.push(arg, takeValue(arg, ++index));
  } else if (["--regex", "--json", "--case-sensitive"].includes(arg)) {
    if (arg === "--json") json = true;
    passthrough.push(arg);
  }
  else {
    fail(`unsupported session-search argument: ${arg}`);
  }
}

if (!["all", "claude", "codex"].includes(targetType)) fail("--target-type must be all, claude, or codex");
if (!Number.isInteger(limit) || limit < 1) fail("--limit must be a positive integer");
if (!Number.isInteger(maxChars) || maxChars < 500) fail("--max-chars must be an integer of at least 500");

const sources = ownerOperator
  ? [{ type: "pi", root: path.join(ooHome, "sessions") }]
  : loadSessionSources(ooHome)
      .filter((source) => source.source === "claude" || source.source === "codex")
      .map((source) => ({ type: source.source, root: source.root }));
if (targetRoot) {
  const wanted = path.resolve(targetRoot);
  if (!sources.some((source) => path.resolve(source.root) === wanted)) {
    fail("--target-root must name a configured session source");
  }
  passthrough.push("--target-root", wanted);
}
const sourceFile = path.join(os.tmpdir(), `oo-session-search-${process.pid}.json`);
fs.writeFileSync(sourceFile, JSON.stringify(sources));

const blacklist = loadBlacklist(ooHome);
const excludePatterns = pathSlugs(blacklist).map((slug) => {
  const escaped = escapeRegex(slug);
  return `(?:^|/)${escaped}(?:-[^/]*)?/[^/]+\\.jsonl$`;
});
const cwdCache = new Map();
const fileBlacklisted = (file) => {
  if (cwdCache.has(file)) return cwdCache.get(file);
  let blocked = true;
  try {
    const cwd = firstCwdFromFile(file);
    blocked = !!cwd && isBlacklisted(blacklist, { cwd, repo: resolveRepo(cwd) });
  } catch {
    blocked = true;
  }
  cwdCache.set(file, blocked);
  return blocked;
};

const browse = input.includes("--skim");
if (browse) {
  for (const { root } of sources) {
    for (const file of walk(root)) {
      if (fileBlacklisted(file)) excludePatterns.push(`^${escapeRegex(file)}$`);
    }
  }
}

const sourceArgs = ["--sources-file", sourceFile];
const typeArgs = ownerOperator || targetType === "all" ? [] : ["--target-type", targetType];
const excludeArgs = excludePatterns.flatMap((pattern) => ["--exclude-re", pattern]);

try {
  if (browse) {
    const result = runPrimitive([
      ...passthrough,
      "--limit", String(limit),
      "--max-chars", String(maxChars),
      ...sourceArgs,
      ...typeArgs,
      ...excludeArgs,
    ]);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.status ?? 1;
  } else {
    const fetchLimit = limit * 3;
    const result = runPrimitive([
      ...passthrough.filter((arg) => arg !== "--json"),
      "--json",
      "--limit", String(fetchLimit),
      "--max-chars", String(Math.max(maxChars * 3, fetchLimit * 1_200)),
      ...sourceArgs,
      ...typeArgs,
      ...excludeArgs,
    ]);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
    } else {
      const output = JSON.parse(result.stdout);
      const allowed = [];
      let blacklistedDropped = 0;
      for (const match of output.matches ?? []) {
        if (fileBlacklisted(match.path)) blacklistedDropped += 1;
        else if (allowed.length < limit) allowed.push(match);
      }
      output.matches = allowed;
      output.shown = allowed.length;
      if (blacklistedDropped) output.blacklistedDropped = blacklistedDropped;

      if (json) process.stdout.write(`${JSON.stringify(output)}\n`);
      else renderText(output, { targetType, blacklistedDropped });
    }
  }
} finally {
  try { fs.unlinkSync(sourceFile); } catch { /* best effort */ }
}

function runPrimitive(args) {
  return spawnSync(process.execPath, [primitive, ...args], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function renderText(output, context) {
  console.log(
    `query=${JSON.stringify(output.query ?? "")} total_message_matches=${output.totalMatches ?? 0} ` +
    `shown=${output.shown ?? 0}${context.targetType !== "all" ? ` target_type=${context.targetType}` : ""}` +
    `${context.blacklistedDropped ? ` blacklisted_dropped=${context.blacklistedDropped}` : ""}`,
  );
  if (output.hint) console.log(`hint: ${output.hint}`);
  for (const [index, match] of (output.matches ?? []).entries()) {
    console.log(`\n[${index + 1}] ${match.source} id=${match.id} idx=${match.index} ts=${match.timestamp ?? ""}`);
    for (const before of match.before ?? []) console.log(`  before ${before.role}: ${before.text}`);
    console.log(`  MATCH ${match.match.role}: ${match.match.text}`);
    for (const after of match.after ?? []) console.log(`  after  ${after.role}: ${after.text}`);
  }
}

function walk(root) {
  const files = [];
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return files; }
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walk(target));
    else if (entry.isFile() && target.endsWith(".jsonl")) files.push(target);
  }
  return files;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function takeValue(flag, index) {
  const value = input[index];
  if (!value || value.startsWith("--")) fail(`${flag} needs a value`);
  return value;
}

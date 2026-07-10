#!/usr/bin/env node
// sync-session-grep — compare session-search's private vendor against upstream.
//
//   node scripts/sync-session-grep.mjs --check
//                                       verify the private vendor is byte-identical to the pinned
//                                       upstream commit (exit 1 on drift, 2 if unreachable)
//   node scripts/sync-session-grep.mjs --apply REF
//                                       re-sync the private vendor from upstream REF, update the pin
//                                       in UPSTREAM.md, and run the primitive's self-test
//
// The upstream URL and pin live beside the private vendor in UPSTREAM.md. Upstream's
// agent-facing SKILL.md is deliberately omitted: this directory is a dependency, while
// Owner Operator exposes its own opinionated skill. UPSTREAM.md itself is ours; local deltas are tracked
// there while waiting to upstream.
// --upstream URL overrides the recorded upstream (tests point this at a local fixture).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const vendorDir = path.join(
  here, "..", "src", "agent", "skills", "session-search", "vendor", "session-grep",
);
const upstreamFile = path.join(vendorDir, "UPSTREAM.md");
const SKILL_DIR = "skills/session-grep"; // where the primitive lives in the upstream repo
const OURS = new Set(["UPSTREAM.md"]);
const OMIT = new Set(["SKILL.md"]);

const args = process.argv.slice(2);
let mode = null, applyRef = null, upstreamOverride = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--check") mode = "check";
  else if (a === "--apply") { mode = "apply"; applyRef = args[++i]; }
  else if (a === "--upstream") upstreamOverride = args[++i];
  else fail(1, `Unknown arg: ${a}\nUsage: scripts/sync-session-grep.mjs --check | --apply REF [--upstream URL]`);
}
if (!mode || (mode === "apply" && !applyRef)) {
  fail(1, "Usage: scripts/sync-session-grep.mjs --check | --apply REF [--upstream URL]");
}

const upstreamMd = fs.readFileSync(upstreamFile, "utf8");
const url = upstreamOverride ?? /\*\*Upstream:\*\*\s*(\S+)/.exec(upstreamMd)?.[1];
const pin = /\*\*Synced from:\*\*\s*`([^`]+)`\s*@\s*`([0-9a-f]{7,40})`/.exec(upstreamMd);
if (!url) fail(1, "UPSTREAM.md: no **Upstream:** URL found");
if (mode === "check" && !pin) fail(1, "UPSTREAM.md: no **Synced from:** `ref` @ `sha` pin found");

// Fetch the wanted commit into a throwaway clone. Fetching by SHA works against GitHub
// (allowReachableSHA1InWant); a ref name works everywhere.
const want = mode === "check" ? pin[2] : applyRef;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "session-grep-sync-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
const git = (...a) => spawnSync("git", ["-C", tmp, ...a], { encoding: "utf8" });
git("init", "-q");
git("remote", "add", "origin", url);
const fetch = git("fetch", "-q", "--depth", "1", "origin", want);
if (fetch.status !== 0) {
  fail(2, `Could not fetch ${want} from ${url} — is upstream pushed and reachable?\n${fetch.stderr.trim()}`);
}
git("checkout", "-q", "FETCH_HEAD");
const sha = git("rev-parse", "FETCH_HEAD").stdout.trim();
const srcDir = path.join(tmp, SKILL_DIR);
if (!fs.existsSync(srcDir)) fail(2, `Upstream commit ${sha} has no ${SKILL_DIR}/ directory`);

// Upstream runtime files only — the upstream skill itself is not active in Owner Operator.
const wanted = new Map(); // vendor-relative name -> upstream absolute path
for (const rel of listFiles(srcDir)) {
  if (!OMIT.has(rel)) wanted.set(rel, path.join(srcDir, rel));
}

if (mode === "check") {
  const have = listFiles(vendorDir).filter((rel) => !OURS.has(rel));
  const drift = [];
  for (const [rel, src] of wanted) {
    const dst = path.join(vendorDir, rel);
    if (!fs.existsSync(dst)) drift.push(`missing: ${rel}`);
    else if (!fs.readFileSync(src).equals(fs.readFileSync(dst))) drift.push(`differs: ${rel}`);
  }
  for (const rel of have) if (!wanted.has(rel)) drift.push(`not upstream's: ${rel}`);
  if (drift.length) {
    fail(1, `private vendor differs from ${url} ${pin[1]} @ ${pin[2]}:\n  ${drift.join("\n  ")}\nIf this is intentional, document the local delta in UPSTREAM.md; otherwise re-sync with --apply or revert the edit.`);
  }
  console.log(`ok — private vendor is verbatim ${url} @ ${sha} (${wanted.size} files)`);
} else {
  for (const rel of listFiles(vendorDir)) {
    if (!OURS.has(rel)) fs.rmSync(path.join(vendorDir, rel));
  }
  for (const [rel, src] of wanted) {
    const dst = path.join(vendorDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  fs.writeFileSync(
    upstreamFile,
    upstreamMd.replace(/(\*\*Synced from:\*\*\s*)`[^`]*`\s*@\s*`[0-9a-f]{7,40}`/, `$1\`${applyRef}\` @ \`${sha}\``),
  );
  console.log(`synced private vendor from ${url} ${applyRef} @ ${sha} (${wanted.size} files); pin updated`);
  const st = spawnSync(process.execPath, [path.join(vendorDir, "session-grep.mjs"), "--self-test"], { stdio: "inherit" });
  if (st.status !== 0) fail(1, "self-test FAILED on the new vendor copy — do not commit");
  console.log("now run the wrapper's integration test: npx tsx test/sessions-grep.integration.test.ts");
}

function listFiles(dir) {
  return fs
    .readdirSync(dir, { recursive: true })
    .map(String)
    .filter((rel) => fs.statSync(path.join(dir, rel)).isFile());
}

function fail(code, msg) {
  console.error(msg);
  process.exit(code);
}

// Unit test of the privacy blacklist: load (missing/invalid → block nothing), path-tree
// matching (the repo AND lower-level repos, case-insensitive, no sibling bleed), repo-name
// matching, and the Claude project-dir slugs.
//   npx tsx src/blacklist.test.ts   (from packages/core/)

import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBlacklist, isBlacklisted, pathSlugs } from "./blacklist.mjs";

const dir = mkdtempSync(join(tmpdir(), "oo-blacklist-"));
try {
  assert.deepEqual(loadBlacklist(dir), { paths: [], repos: [] }, "missing file blocks nothing");

  writeFileSync(join(dir, "blacklist.json"), "{not json");
  assert.deepEqual(loadBlacklist(dir), { paths: [], repos: [] }, "invalid file blocks nothing");

  writeFileSync(join(dir, "blacklist.json"), JSON.stringify({ paths: ["/Users/x/Documents/Personal/"], repos: ["Personal"] }));
  const bl = loadBlacklist(dir);
  assert.deepEqual(bl, { paths: ["/Users/x/Documents/Personal"], repos: ["Personal"] }, "trailing slash trimmed");

  // Path tree: the repo itself and every lower-level repo; case-insensitive (APFS is);
  // a sibling that merely shares the prefix never bleeds in.
  assert.ok(isBlacklisted(bl, { cwd: "/Users/x/Documents/Personal" }), "the tree root");
  assert.ok(isBlacklisted(bl, { cwd: "/Users/x/Documents/Personal/Career/Jobs/acme" }), "a lower-level repo");
  assert.ok(isBlacklisted(bl, { cwd: "/users/x/documents/personal/notes" }), "case-insensitive");
  assert.ok(!isBlacklisted(bl, { cwd: "/Users/x/Documents/PersonalSite" }), "sibling prefix doesn't bleed");

  // Repo name: the safety net for worktrees of a blacklisted repo living elsewhere.
  assert.ok(isBlacklisted(bl, { repo: "personal" }), "repo name, case-insensitive");
  assert.ok(!isBlacklisted(bl, { repo: "personality" }), "repo match is exact, not prefix");
  assert.ok(!isBlacklisted(bl, {}), "no identity → no match");

  assert.deepEqual(pathSlugs(bl), ["-Users-x-Documents-Personal"], "claude project-dir slug");

  process.stdout.write("ok — blacklist: load, path tree, repo name, slugs\n");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

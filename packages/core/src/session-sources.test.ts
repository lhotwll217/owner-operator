// Unit test for the session-sources loader: defaults, `add`, `disable`, ~ expansion, the
// unknown-source guard, and invalid-config fallback.
//   tsx src/session-sources.test.ts

import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { loadSessionSources, KNOWN_SESSION_SOURCES } from "./session-sources.mjs";

const ooHome = mkdtempSync(join(tmpdir(), "oo-sources-"));
const has = (rows: { source: string; root: string }[], source: string, root: string): boolean =>
  rows.some((r) => r.source === source && r.root === root);

try {
  // No config → built-in defaults: every known source, rooted under $HOME.
  const def = loadSessionSources(ooHome);
  assert.deepEqual(
    [...new Set(def.map((s) => s.source))].sort(),
    [...KNOWN_SESSION_SOURCES].sort(),
    "defaults cover all known sources",
  );
  assert.ok(def.every((s) => s.root.startsWith(homedir())), "default roots live under home");
  assert.ok(has(def, "cursor", join(homedir(), ".cursor", "projects")), "cursor default present");
  assert.ok(has(def, "pi", join(homedir(), ".pi", "agent", "sessions")), "pi default present");
  assert.ok(has(def, "opencode", join(homedir(), ".local", "share", "opencode", "storage")), "opencode default present");
  assert.ok(
    has(def, "antigravity", join(homedir(), ".gemini", "antigravity")) &&
      has(def, "antigravity", join(homedir(), ".gemini", "antigravity-cli")),
    "antigravity covers both the IDE and CLI dirs",
  );
  assert.ok(has(def, "grok-build", join(homedir(), ".grok", "sessions")), "grok-build default present");

  // add appends; disable drops a default; ~ expands; unknown source ignored.
  writeFileSync(join(ooHome, "session_sources.json"), JSON.stringify({
    disable: ["cursor"],
    add: [
      { source: "posthog-code", root: "/work/ph/sessions" },
      { source: "claude", root: "~/alt/claude" },
      { source: "bogus", root: "/nope" },
    ],
  }));
  const cfg = loadSessionSources(ooHome);
  assert.ok(!cfg.some((s) => s.source === "cursor"), "disable drops the default cursor root");
  assert.ok(has(cfg, "posthog-code", "/work/ph/sessions"), "add appends an extra root");
  assert.ok(has(cfg, "claude", join(homedir(), "alt/claude")), "~/ expands to $HOME");
  assert.ok(!cfg.some((s) => s.source === "bogus"), "unknown source ignored — no parser for it");
  assert.ok(has(cfg, "claude", join(homedir(), ".claude", "projects")), "non-disabled defaults remain");

  // De-dup: an `add` restating a default collapses to one entry.
  writeFileSync(join(ooHome, "session_sources.json"), JSON.stringify({
    add: [{ source: "codex", root: join(homedir(), ".codex", "sessions") }],
  }));
  const deduped = loadSessionSources(ooHome).filter((s) => s.source === "codex");
  assert.equal(deduped.length, 1, "duplicate (source, root) collapses");

  // Invalid JSON → defaults (never throws).
  writeFileSync(join(ooHome, "session_sources.json"), "{ not json");
  assert.deepEqual(
    [...new Set(loadSessionSources(ooHome).map((s) => s.source))].sort(),
    [...KNOWN_SESSION_SOURCES].sort(),
    "invalid config falls back to defaults",
  );

  process.stdout.write("ok — session-sources: defaults, add, disable, ~ expand, unknown-source guard, dedup, invalid fallback\n");
} finally {
  rmSync(ooHome, { recursive: true, force: true });
}

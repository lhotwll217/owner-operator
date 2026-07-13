// Unit test for the session-sources loader: defaults, `add`, `disable`, ~ expansion, the
// unknown-source guard, and invalid-config fallback.
//   tsx src/session-sources.test.ts

import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  AGENT_HARNESS_DESCRIPTORS,
  KNOWN_AGENT_HARNESSES,
  KNOWN_SESSION_SOURCES,
  KNOWN_TRANSCRIPT_FORMATS,
  assertTranscriptFormatCoverage,
  loadSessionSources,
  loadTranscriptAccess,
  loadTranscriptStores,
} from "./session-sources.mjs";

const ooHome = mkdtempSync(join(tmpdir(), "oo-sources-"));
const has = (rows: { source: string; root: string }[], source: string, root: string): boolean =>
  rows.some((r) => r.source === source && r.root === root);

try {
  assert.deepEqual(
    AGENT_HARNESS_DESCRIPTORS.map(({ id, label, transcriptFormat }) => ({ id, label, transcriptFormat })),
    [
      { id: "claude-code", label: "Claude Code", transcriptFormat: "claude" },
      { id: "codex", label: "Codex", transcriptFormat: "codex" },
      { id: "cursor-agent", label: "Cursor Agent", transcriptFormat: "cursor" },
      { id: "posthog-code", label: "PostHog Code", transcriptFormat: "posthog-code" },
      { id: "pi", label: "Pi", transcriptFormat: "pi" },
      { id: "opencode", label: "OpenCode", transcriptFormat: "opencode" },
      { id: "antigravity", label: "Antigravity", transcriptFormat: "antigravity" },
      { id: "grok-build", label: "Grok Build", transcriptFormat: "grok-build" },
    ],
    "one catalog separates owner-facing harness identity from the transcript format",
  );
  assert.deepEqual(KNOWN_AGENT_HARNESSES, AGENT_HARNESS_DESCRIPTORS.map(({ id }) => id));
  assert.deepEqual(KNOWN_TRANSCRIPT_FORMATS, KNOWN_SESSION_SOURCES, "legacy source IDs are transcript-format IDs");
  assert.doesNotThrow(() => assertTranscriptFormatCoverage(KNOWN_TRANSCRIPT_FORMATS));
  assert.throws(
    () => assertTranscriptFormatCoverage(KNOWN_TRANSCRIPT_FORMATS.filter((format) => format !== "pi")),
    /missing: pi/,
    "a catalog entry without an implementation fails completeness validation",
  );

  // No config → built-in defaults: every known source, rooted under $HOME.
  const def = loadSessionSources(ooHome);
  assert.deepEqual(
    [...new Set(def.map((s) => s.source))].sort(),
    [...KNOWN_SESSION_SOURCES].sort(),
    "defaults cover all known sources",
  );
  assert.ok(def.every((s) => s.root.startsWith(homedir())), "default roots live under home");
  assert.ok(has(def, "cursor", join(homedir(), ".cursor", "projects")), "cursor default present");
  assert.ok(has(def, "claude", join(homedir(), ".config", "claude", "projects")), "common standard roots are enabled with the harness");
  assert.ok(has(def, "pi", join(homedir(), ".pi", "agent", "sessions")), "pi default present");
  assert.ok(has(def, "opencode", join(homedir(), ".local", "share", "opencode", "storage")), "opencode default present");
  assert.ok(
    has(def, "antigravity", join(homedir(), ".gemini", "antigravity")) &&
      has(def, "antigravity", join(homedir(), ".gemini", "antigravity-cli")),
    "antigravity covers both the IDE and CLI dirs",
  );
  assert.ok(has(def, "grok-build", join(homedir(), ".grok", "sessions")), "grok-build default present");
  assert.deepEqual(
    loadTranscriptStores(ooHome).map(({ format, root }) => ({ source: format, root })),
    def,
    "domain loader returns transcript stores while the legacy source loader stays compatible",
  );

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

  const access = loadTranscriptAccess(ooHome);
  assert.ok(access.selectedFormats.includes("claude"), "an explicit relocated root keeps its harness selected");
  assert.ok(!access.defaultFormats.includes("cursor"), "disabled standard roots remain a separate permission");

  writeFileSync(join(ooHome, "session_sources.json"), JSON.stringify({
    disable: ["claude"],
    add: [{ source: "claude", root: "/relocated/claude" }],
  }));
  const relocated = loadTranscriptAccess(ooHome);
  assert.ok(relocated.selectedFormats.includes("claude"), "a relocated store keeps its harness selected");
  assert.ok(!relocated.defaultFormats.includes("claude"), "relocation does not reauthorize standard stores");
  assert.deepEqual(loadSessionSources(ooHome).filter(({ source }) => source === "claude"), [
    { source: "claude", root: "/relocated/claude" },
  ]);

  // De-dup: an `add` restating a default collapses to one entry.
  writeFileSync(join(ooHome, "session_sources.json"), JSON.stringify({
    add: [{ source: "codex", root: join(homedir(), ".codex", "sessions") }],
  }));
  const deduped = loadSessionSources(ooHome).filter((s) =>
    s.source === "codex" && s.root === join(homedir(), ".codex", "sessions"));
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

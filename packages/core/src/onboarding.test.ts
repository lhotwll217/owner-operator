// Unit test for onboarding writers + detection: the first-run marker, the merging config writers
// (blacklist / session-sources / active-window), and source detection over a fake ooHome + roots.
//   tsx src/onboarding.test.ts

import assert from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBlacklist } from "./blacklist.mjs";
import { loadActiveWindow } from "./settings.mjs";
import { loadSessionSources, KNOWN_SESSION_SOURCES } from "./session-sources.mjs";
import {
  ONBOARDING_VERSION,
  ONBOARDING_STEPS,
  detectPiConfiguration,
  importPiConfiguration,
  isOnboarded,
  markOnboardingStep,
  markOnboarded,
  pendingOnboardingSteps,
  addBlacklistEntries,
  addSessionRoot,
  disableSessionSource,
  saveActiveWindow,
  detectSources,
  summarizeDetectedSources,
} from "./onboarding.mjs";

const ooHome = mkdtempSync(join(tmpdir(), "oo-onboarding-"));

try {
  // First-run marker: absent before, step-based, and complete only at the current version.
  assert.equal(isOnboarded(ooHome), false, "no marker → not onboarded");
  markOnboardingStep(ooHome, "intro");
  assert.equal(isOnboarded(ooHome), false, "one completed step does not finish onboarding");
  assert.deepEqual(pendingOnboardingSteps(ooHome), ONBOARDING_STEPS.filter((step) => step !== "intro"));
  const marker = markOnboarded(ooHome, { via: "test" });
  assert.equal(marker.version, ONBOARDING_VERSION, "marker records the version");
  assert.equal(marker.via, "test", "marker carries provenance");
  assert.ok(typeof marker.at === "string", "marker records a timestamp");
  assert.equal(isOnboarded(ooHome), true, "marker present → onboarded");

  // Pi migration is explicit and owned: all auth entries and custom models are copied, while
  // resource/package settings are excluded from the model-settings import.
  const piAgentDir = mkdtempSync(join(tmpdir(), "oo-pi-source-"));
  writeFileSync(join(piAgentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "a" }, codex: { type: "oauth", access: "b" } }));
  writeFileSync(join(piAgentDir, "settings.json"), JSON.stringify({
    defaultProvider: "codex",
    defaultModel: "gpt-test",
    defaultThinkingLevel: "high",
    enabledModels: ["codex/*"],
    packages: ["ambient-package"],
    extensions: ["ambient-extension"],
    skills: ["ambient-skill"],
  }));
  writeFileSync(join(piAgentDir, "models.json"), JSON.stringify({ providers: { local: { baseUrl: "http://localhost" } } }));
  assert.deepEqual(detectPiConfiguration(piAgentDir), { auth: true, settings: true, models: true });
  const imported = importPiConfiguration(ooHome, piAgentDir);
  assert.deepEqual(imported, { auth: true, settings: true, models: true, source: piAgentDir });
  const ownedPi = join(ooHome, "pi");
  assert.deepEqual(JSON.parse(readFileSync(join(ownedPi, "auth.json"), "utf8")), {
    anthropic: { type: "api_key", key: "a" },
    codex: { type: "oauth", access: "b" },
  });
  assert.equal(statSync(join(ownedPi, "auth.json")).mode & 0o777, 0o600, "owned credentials are private");
  assert.deepEqual(JSON.parse(readFileSync(join(ownedPi, "settings.json"), "utf8")), {
    defaultProvider: "codex",
    defaultModel: "gpt-test",
    defaultThinkingLevel: "high",
    enabledModels: ["codex/*"],
  });
  assert.deepEqual(JSON.parse(readFileSync(join(ownedPi, "models.json"), "utf8")), {
    providers: { local: { baseUrl: "http://localhost" } },
  });
  rmSync(piAgentDir, { recursive: true, force: true });

  // Blacklist writer merges + de-dupes with what the loader reads back, and strips trailing slashes.
  addBlacklistEntries(ooHome, { paths: ["/work/clientX/"], repos: ["Personal"] });
  addBlacklistEntries(ooHome, { paths: ["/work/clientX", "/home/me/secret"], repos: ["Personal", "Vault"] });
  const bl = loadBlacklist(ooHome);
  assert.deepEqual(bl.paths.sort(), ["/home/me/secret", "/work/clientX"], "paths merged, de-duped, slash-stripped");
  assert.deepEqual(bl.repos.sort(), ["Personal", "Vault"], "repos merged and de-duped");

  // Session-source writer: a known source at a new root shows up in loadSessionSources; a second
  // identical add is a no-op; an unknown source throws (a root with no parser is dead config).
  addSessionRoot(ooHome, "claude", "/alt/claude");
  addSessionRoot(ooHome, "claude", "/alt/claude");
  const roots = loadSessionSources(ooHome);
  assert.equal(roots.filter((r) => r.source === "claude" && r.root === "/alt/claude").length, 1, "added root once, de-duped");
  assert.throws(() => addSessionRoot(ooHome, "nope", "/x"), /unknown session source/, "unknown source rejected");

  // Disabling a default source drops its built-in roots from the resolved list.
  disableSessionSource(ooHome, "cursor");
  assert.ok(!loadSessionSources(ooHome).some((r) => r.source === "cursor"), "disabled source dropped");

  // Active-window writer validates against the shared grammar; a typo throws, a good spec loads back.
  assert.throws(() => saveActiveWindow(ooHome, "whenever"), /invalid active window/, "typo rejected before write");
  saveActiveWindow(ooHome, "36h");
  assert.equal(loadActiveWindow(ooHome), "36h", "valid window written and loaded back");

  // Detection over a fake root: seed session files and confirm exists+count, then the per-source rollup.
  const detectHome = mkdtempSync(join(tmpdir(), "oo-detect-"));
  const claudeRoot = join(detectHome, "sessions");
  mkdirSync(join(claudeRoot, "proj"), { recursive: true });
  writeFileSync(join(claudeRoot, "proj", "a.jsonl"), "{}\n");
  writeFileSync(join(claudeRoot, "proj", "b.jsonl"), "{}\n");
  writeFileSync(join(claudeRoot, "proj", "notes.txt"), "ignore me");
  for (const source of KNOWN_SESSION_SOURCES) disableSessionSource(detectHome, source);
  addSessionRoot(detectHome, "claude", claudeRoot);
  const missingRoot = join(detectHome, "missing-codex");
  addSessionRoot(detectHome, "codex", missingRoot);
  const detected = detectSources(detectHome);
  const claude = detected.find((d) => d.root === claudeRoot);
  assert.ok(claude && claude.exists && claude.count === 2, "detects the 2 seeded session files, ignores .txt");
  const missing = detected.find((d) => d.source === "codex" && d.root === missingRoot);
  assert.ok(missing && !missing.exists && missing.count === 0, "a non-existent default root reads as absent");
  const summary = summarizeDetectedSources(detected);
  assert.ok(summary.find((s) => s.source === "claude")?.count >= 2, "rollup sums a source's roots");
  rmSync(detectHome, { recursive: true, force: true });

  process.stdout.write("ok — onboarding: marker, merging writers (blacklist/sources/window), source detection\n");
} finally {
  rmSync(ooHome, { recursive: true, force: true });
}

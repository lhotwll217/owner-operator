// Integration test for onboarding writers, Pi import, and source detection over isolated roots.
//   tsx src/onboarding.integration.test.ts

import assert from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBlacklist } from "./blacklist.mjs";
import { loadActiveWindow } from "./settings.mjs";
import { ownerOperatorPaths } from "./harness.mjs";
import {
  AGENT_HARNESS_DESCRIPTORS,
  KNOWN_AGENT_HARNESSES,
  KNOWN_SESSION_SOURCES,
  KNOWN_TRANSCRIPT_FORMATS,
  loadSessionSources,
} from "./session-sources.mjs";
import { REVIEWED_SESSION_HOSTS, SESSION_HOST_DESCRIPTORS } from "./session-hosts.mjs";
import {
  ONBOARDING_VERSION,
  ONBOARDING_STEPS,
  detectPiConfiguration,
  detectSessionSourceCandidates,
  detectSessionHostCandidates,
  importPiConfiguration,
  isOnboarded,
  loadPiImportDecision,
  markOnboardingStep,
  markOnboarded,
  pendingOnboardingSteps,
  recordPiImportDecision,
  addBlacklistEntries,
  addSessionRoot,
  disableSessionSource,
  saveSessionRoots,
  saveTranscriptAccess,
  saveSessionHostRoots,
  saveActiveWindow,
  sessionCatalogReviewContract,
  detectSources,
  summarizeDetectedSources,
} from "./onboarding.mjs";

const ooHome = mkdtempSync(join(tmpdir(), "oo-onboarding-"));

try {
  // First-run marker: absent before, step-based, and complete only at the current version.
  assert.equal(isOnboarded(ooHome), false, "no marker → not onboarded");
  assert.equal(loadPiImportDecision(ooHome), null);
  assert.equal(recordPiImportDecision(ooHome, "declined"), "declined");
  assert.equal(loadPiImportDecision(ooHome), "declined", "import choice persists without completing auth");
  markOnboardingStep(ooHome, "intro");
  assert.equal(isOnboarded(ooHome), false, "one completed step does not finish onboarding");
  assert.deepEqual(pendingOnboardingSteps(ooHome), ONBOARDING_STEPS.filter((step) => step !== "intro"));
  const marker = markOnboarded(ooHome, { via: "test" });
  assert.equal(marker.version, ONBOARDING_VERSION, "marker records the version");
  assert.equal(marker.via, "test", "marker carries provenance");
  assert.ok(typeof marker.at === "string", "marker records a timestamp");
  assert.equal(isOnboarded(ooHome), true, "marker present → onboarded");
  const markerPath = join(ooHome, "onboarded.json");
  const oldVersion = JSON.parse(readFileSync(markerPath, "utf8"));
  oldVersion.version = ONBOARDING_VERSION - 1;
  delete oldVersion.authVersion;
  writeFileSync(markerPath, JSON.stringify(oldVersion));
  assert.deepEqual(pendingOnboardingSteps(ooHome), ["auth"], "older markers must pass the current model authorization check");
  markOnboardingStep(ooHome, "auth");
  assert.equal(isOnboarded(ooHome), true);

  const staleCatalog = JSON.parse(readFileSync(markerPath, "utf8"));
  staleCatalog.reviewedSessionHosts = staleCatalog.reviewedSessionHosts.slice(0, -1);
  staleCatalog.sessionCatalogHash = "stale";
  writeFileSync(markerPath, JSON.stringify(staleCatalog));
  assert.equal(isOnboarded(ooHome), false, "a catalog addition reopens consent");
  assert.deepEqual(pendingOnboardingSteps(ooHome), ["session-sources"], "only the catalog review reopens");
  markOnboardingStep(ooHome, "session-sources", {
    reviewedHarnesses: [...KNOWN_AGENT_HARNESSES],
    reviewedSessionHosts: [...REVIEWED_SESSION_HOSTS],
  });
  assert.equal(isOnboarded(ooHome), true, "reviewing the current catalog closes the marker");

  const catalogContract = sessionCatalogReviewContract();
  assert.deepEqual(sessionCatalogReviewContract(
    AGENT_HARNESS_DESCRIPTORS.map((descriptor, index) => index === 0
      ? { ...descriptor, label: "Renamed", declared: [], deep: [] }
      : descriptor),
    SESSION_HOST_DESCRIPTORS.map((descriptor, index) => index === 0
      ? { ...descriptor, label: "Renamed", appNames: ["New app alias"], commands: ["new-command"] }
      : descriptor),
  ), catalogContract, "cosmetic and detection-hint edits do not reopen consent");
  assert.notDeepEqual(sessionCatalogReviewContract(
    AGENT_HARNESS_DESCRIPTORS.map((descriptor, index) => index === 0
      ? { ...descriptor, defaults: [...descriptor.defaults, ["new-standard-root"]] }
      : descriptor),
    SESSION_HOST_DESCRIPTORS,
  ), catalogContract, "standard transcript access changes reopen consent");
  assert.notDeepEqual(sessionCatalogReviewContract(
    AGENT_HARNESS_DESCRIPTORS,
    SESSION_HOST_DESCRIPTORS.map((descriptor, index) => index === 0
      ? { ...descriptor, harnesses: [] }
      : descriptor),
  ), catalogContract, "host attribution changes reopen consent");
  assert.notDeepEqual(sessionCatalogReviewContract(
    AGENT_HARNESS_DESCRIPTORS,
    SESSION_HOST_DESCRIPTORS.map((descriptor, index) => index === 0
      ? { ...descriptor, defaultRoots: [["changed-host-root"]] }
      : descriptor),
  ), catalogContract, "host root matcher changes reopen consent");

  // Pi migration is explicit and owned: all auth entries and custom models are copied, while
  // resource/package settings are excluded from the model-settings import.
  const piAgentDir = mkdtempSync(join(tmpdir(), "oo-pi-source-"));
  writeFileSync(join(piAgentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "a" }, codex: { type: "oauth", access: "b" } }));
  writeFileSync(join(piAgentDir, "settings.json"), JSON.stringify({
    defaultProvider: "codex",
    defaultModel: "gpt-test",
    defaultThinkingLevel: "high",
    httpProxy: "http://127.0.0.1:8080",
    httpIdleTimeoutMs: 120000,
    websocketConnectTimeoutMs: 15000,
    enabledModels: ["codex/*"],
    packages: ["ambient-package"],
    extensions: ["ambient-extension"],
    skills: ["ambient-skill"],
  }));
  writeFileSync(join(piAgentDir, "models.json"), JSON.stringify({ providers: { local: { baseUrl: "http://localhost" } } }));
  assert.deepEqual(detectPiConfiguration(piAgentDir), { auth: true, settings: true, models: true, selectedModel: true, selectedModelAuthorized: true });
  const imported = importPiConfiguration(ooHome, piAgentDir);
  assert.deepEqual(imported, { auth: true, settings: true, models: true, selectedModel: true, selectedModelAuthorized: true, source: piAgentDir });
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
    httpProxy: "http://127.0.0.1:8080",
    httpIdleTimeoutMs: 120000,
    websocketConnectTimeoutMs: 15000,
    enabledModels: ["codex/*"],
  });
  assert.deepEqual(JSON.parse(readFileSync(join(ownedPi, "models.json"), "utf8")), {
    providers: { local: { baseUrl: "http://localhost" } },
  });
  rmSync(piAgentDir, { recursive: true, force: true });

  // Session roots are candidates, not configuration: declared roots are tier 1, fixed defaults
  // tier 2, and the bounded home walk is opt-in tier 3 with blacklist pruning.
  const sourceHome = mkdtempSync(join(tmpdir(), "oo-source-home-"));
  const detectionOoHome = join(sourceHome, "oo-home");
  const codexHome = join(sourceHome, "relocated-codex");
  const claudeHome = join(sourceHome, "relocated-claude");
  const piHome = join(sourceHome, "relocated-pi");
  const piSessions = join(piHome, "custom-sessions");
  mkdirSync(join(codexHome, "sessions"), { recursive: true });
  mkdirSync(join(claudeHome, "projects"), { recursive: true });
  mkdirSync(join(sourceHome, ".cursor", "projects"), { recursive: true });
  mkdirSync(piSessions, { recursive: true });
  writeFileSync(join(codexHome, "sessions", "one.jsonl"), "{}\n");
  writeFileSync(join(claudeHome, "projects", "one.jsonl"), "{}\n");
  writeFileSync(join(piSessions, "one.jsonl"), "{}\n");
  writeFileSync(join(piHome, "settings.json"), JSON.stringify({ sessionDir: "custom-sessions" }));
  const declared = detectSessionSourceCandidates(detectionOoHome, {
    home: sourceHome,
    env: { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, PI_CODING_AGENT_DIR: piHome },
  });
  assert.ok(declared.some((candidate) => candidate.tier === 1 && candidate.source === "codex" && candidate.root === join(codexHome, "sessions")));
  assert.ok(declared.some((candidate) => candidate.tier === 1 && candidate.source === "claude" && candidate.root === join(claudeHome, "projects")));
  assert.ok(declared.some((candidate) => candidate.tier === 1 && candidate.source === "pi" && candidate.root === piSessions));
  assert.ok(declared.some((candidate) => candidate.tier === 2 && candidate.source === "cursor" && candidate.exists && !candidate.shape), "tier 2 checks existence without listing for session shape");

  const discoveredCodex = join(sourceHome, "archive", ".codex", "sessions");
  const blockedClaude = join(sourceHome, "blocked", ".claude", "projects");
  mkdirSync(discoveredCodex, { recursive: true });
  mkdirSync(blockedClaude, { recursive: true });
  writeFileSync(join(discoveredCodex, "deep.jsonl"), "{}\n");
  writeFileSync(join(blockedClaude, "private.jsonl"), "{}\n");
  addBlacklistEntries(detectionOoHome, { paths: [join(sourceHome, "blocked")] });
  addBlacklistEntries(detectionOoHome, { repos: ["repo-blocked"] });
  const repoBlocked = join(sourceHome, "repo-blocked", ".codex", "sessions");
  mkdirSync(repoBlocked, { recursive: true });
  writeFileSync(join(repoBlocked, "private.jsonl"), "{}\n");
  const deep = detectSessionSourceCandidates(detectionOoHome, {
    home: sourceHome,
    env: {},
    deep: true,
    maxDepth: 5,
    timeoutMs: 2_000,
    volumes: [],
  });
  assert.ok(deep.some((candidate) => candidate.tier === 3 && candidate.source === "codex" && candidate.root === discoveredCodex));
  assert.ok(!deep.some((candidate) => candidate.root.startsWith(join(sourceHome, "blocked"))), "deep detection prunes the privacy blacklist");
  assert.ok(!deep.some((candidate) => candidate.root.startsWith(join(sourceHome, "repo-blocked"))), "deep detection prunes blacklisted repository names");
  rmSync(sourceHome, { recursive: true, force: true });

  // Superset's worktree home is configuration, not a fixed path. Read both its legacy local DB
  // and current per-host DB without opening a transcript.
  const supersetHome = mkdtempSync(join(tmpdir(), "oo-superset-home-"));
  const legacyRoot = join(supersetHome, "legacy-worktrees");
  const currentRoot = join(supersetHome, "current-worktrees");
  const applications = join(supersetHome, "Applications");
  const bin = join(supersetHome, "bin");
  mkdirSync(legacyRoot, { recursive: true });
  mkdirSync(currentRoot, { recursive: true });
  mkdirSync(join(applications, "Claude.app"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "codex"), "#!/bin/sh\n");
  chmodSync(join(bin, "codex"), 0o755);
  writeFileSync(join(bin, "claude"), "#!/bin/sh\n");
  chmodSync(join(bin, "claude"), 0o755);
  const { DatabaseSync } = await import("node:sqlite");
  const legacyDb = new DatabaseSync(join(supersetHome, "local.db"));
  legacyDb.exec("CREATE TABLE settings (worktree_base_dir TEXT)");
  legacyDb.prepare("INSERT INTO settings VALUES (?)").run(legacyRoot);
  legacyDb.close();
  const hostDir = join(supersetHome, "host", "example");
  mkdirSync(hostDir, { recursive: true });
  const currentDb = new DatabaseSync(join(hostDir, "host.db"));
  currentDb.exec("CREATE TABLE projects (worktree_base_dir TEXT)");
  currentDb.prepare("INSERT INTO projects VALUES (?)").run(currentRoot);
  currentDb.close();
  const hosts = await detectSessionHostCandidates(join(supersetHome, "oo"), {
    home: supersetHome,
    env: { SUPERSET_HOME_DIR: supersetHome, PATH: bin },
    applications: [applications],
  });
  assert.ok(hosts.some(({ host, root, origin }) => host === "superset" && root === legacyRoot && origin === "superset-settings"));
  assert.ok(hosts.some(({ host, root, origin }) => host === "superset" && root === currentRoot && origin === "superset-settings"));
  assert.ok(hosts.some(({ host, origin }) => host === "claude-app" && origin === "app"), "app detection remains distinct from Claude CLI");
  assert.ok(hosts.some(({ host, origin }) => host === "codex-cli" && origin === "command"), "CLI detection remains distinct from Codex App");
  assert.ok(hosts.some(({ host, origin }) => host === "claude-cli" && origin === "command"), "Claude executable detects Claude CLI, not its SDK transport");
  rmSync(supersetHome, { recursive: true, force: true });

  // Blacklist writer merges + de-dupes with what the loader reads back, and strips trailing slashes.
  addBlacklistEntries(ooHome, { paths: ["/work/clientX/"], repos: ["Personal"] });
  addBlacklistEntries(ooHome, { paths: ["/work/clientX", "/home/me/secret"], repos: ["Personal", "Vault"] });
  const bl = loadBlacklist(ooHome);
  assert.deepEqual(bl.paths.sort(), ["/home/me/secret", "/work/clientX"], "paths merged, de-duped, slash-stripped");
  assert.deepEqual(bl.repos.sort(), ["Personal", "Vault"], "repos merged and de-duped");
  const permissionConfig = JSON.parse(readFileSync(ownerOperatorPaths(ooHome).piPermissionConfig, "utf8"));
  assert.equal(
    permissionConfig.permission["/work/clientX"],
    undefined,
    "blacklist paths belong to the Pi path surface, not the root permission map",
  );
  assert.equal(permissionConfig.permission.path["/work/clientX"].action, "deny");
  assert.equal(permissionConfig.permission.path["/home/me/secret"].action, "deny");

  // Session-source writer: a known source at a new root shows up in loadSessionSources; a second
  // identical add is a no-op; an unknown source throws (a root with no parser is dead config).
  addSessionRoot(ooHome, "claude", "/alt/claude");
  addSessionRoot(ooHome, "claude", "/alt/claude");
  const roots = loadSessionSources(ooHome);
  assert.equal(roots.filter((r) => r.source === "claude" && r.root === "/alt/claude").length, 1, "added root once, de-duped");
  assert.throws(() => addSessionRoot(ooHome, "nope", "/x"), /unknown session source/, "unknown source rejected");

  saveTranscriptAccess(ooHome, KNOWN_TRANSCRIPT_FORMATS.filter((format) => format !== "cursor"), [
    { source: "codex", root: "/reviewed/codex" },
  ]);
  assert.ok(!loadSessionSources(ooHome).some(({ source }) => source === "cursor"), "ignored harness format is disabled");
  assert.ok(loadSessionSources(ooHome).some(({ source, root }) => source === "codex" && root === "/reviewed/codex"));
  assert.deepEqual(saveSessionHostRoots(ooHome, [{ host: "superset", root: "/custom/superset" }]), [
    { host: "superset", root: "/custom/superset" },
  ]);
  assert.deepEqual(saveSessionHostRoots(ooHome, [{ host: "conductor", root: "/custom/conductor" }]), [
    { host: "superset", root: "/custom/superset" },
    { host: "conductor", root: "/custom/conductor" },
  ], "a later detection pass preserves configured host roots that may be temporarily offline");

  // Disabling a default source drops its built-in roots from the resolved list.
  disableSessionSource(ooHome, "cursor");
  assert.ok(!loadSessionSources(ooHome).some((r) => r.source === "cursor"), "disabled source dropped");
  saveSessionRoots(ooHome, [{ source: "codex", root: "/only/codex" }]);
  assert.deepEqual(loadSessionSources(ooHome), [{ source: "codex", root: "/only/codex" }], "confirmed roots replace earlier choices");

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

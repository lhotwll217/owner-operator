import assert from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KNOWN_AGENT_HARNESSES,
  KNOWN_TRANSCRIPT_FORMATS,
  REVIEWED_SESSION_HOSTS,
  isOnboarded,
  loadBlacklist,
  loadHarnessSettings,
  loadSessionSources,
  type SessionSourceCandidate,
} from "@owner-operator/core";
import { runOnboarding } from "./onboarding";

const root = mkdtempSync(join(tmpdir(), "oo-onboarding-flow-"));
const ooHome = join(root, "oo-home");
const piAgentDir = join(root, "pi-agent");
const codexRoot = join(root, "codex-sessions");
const blocked = join(root, "Private");
mkdirSync(piAgentDir, { recursive: true });
mkdirSync(codexRoot, { recursive: true });
writeFileSync(join(codexRoot, "one.jsonl"), "{}\n");
writeFileSync(join(piAgentDir, "auth.json"), JSON.stringify({ codex: { type: "api_key", key: "token" } }));
writeFileSync(join(piAgentDir, "settings.json"), JSON.stringify({ defaultProvider: "codex", defaultModel: "gpt-test", extensions: ["ambient"] }));

const confirms = [true, true, false]; // intro, Pi import, always-on
const inputs = [blocked, "calendar, mail"];
const selects = ["36h", "Selected personal skills"];
const asked: string[] = [];
const ui = {
  async confirm(title: string): Promise<boolean> { asked.push(title); return confirms.shift() ?? false; },
  async input(title: string): Promise<string | undefined> { asked.push(title); return inputs.shift(); },
  async select(title: string): Promise<string | undefined> { asked.push(title); return selects.shift(); },
  notify(): void {},
};

const candidates: SessionSourceCandidate[] = [{
  source: "codex",
  root: codexRoot,
  tier: 1,
  exists: true,
  shape: false,
}];
let installCalls = 0;

try {
  const completed = await runOnboarding({ hasUI: true, ui } as any, {
    ooHome,
    piAgentDir,
    platform: "darwin",
    detectCandidates: (_deep) => candidates,
    detectHosts: () => [{ host: "superset", root: join(root, "superset-worktrees"), exists: true, origin: "superset-settings" }],
    reviewCatalog: async (catalog) => {
      asked.push("Agent session access");
      assert.deepEqual(catalog.harnesses.map(({ id }) => id), [...KNOWN_AGENT_HARNESSES]);
      assert.deepEqual(catalog.hosts.map(({ id }) => id), [...REVIEWED_SESSION_HOSTS]);
      assert.ok(catalog.harnesses.find(({ id }) => id === "codex")?.detected);
      assert.ok(catalog.hosts.find(({ id }) => id === "superset")?.detected);
      const selectedFormats = KNOWN_TRANSCRIPT_FORMATS.filter((format) => format !== "cursor");
      return {
        selectedFormats,
        defaultFormats: selectedFormats,
        roots: [{ format: "codex", root: codexRoot }],
      };
    },
    resolveModel: () => true,
    installAlwaysOn: async () => { installCalls += 1; },
  });
  assert.equal(completed, true);
  assert.equal(isOnboarded(ooHome), true);
  assert.deepEqual(loadBlacklist(ooHome).paths, [blocked]);
  assert.deepEqual(JSON.parse(readFileSync(join(ooHome, "pi", "auth.json"), "utf8")), {
    codex: { type: "api_key", key: "token" },
  });
  assert.deepEqual(JSON.parse(readFileSync(join(ooHome, "pi", "settings.json"), "utf8")), {
    defaultProvider: "codex",
    defaultModel: "gpt-test",
  });
  const configuredRoots = loadSessionSources(ooHome);
  assert.ok(configuredRoots.some(({ source, root }) => source === "codex" && root === codexRoot));
  assert.ok(!configuredRoots.some(({ source }) => source === "cursor"), "the harness marked ignored is excluded");
  const sourceConfig = JSON.parse(readFileSync(join(ooHome, "session_sources.json"), "utf8"));
  assert.deepEqual(sourceConfig.disable, ["cursor"], "only harnesses marked ignored are disabled");
  assert.deepEqual(JSON.parse(readFileSync(join(ooHome, "session_hosts.json"), "utf8")).roots, [
    { host: "superset", root: join(root, "superset-worktrees") },
  ]);
  const settings = loadHarnessSettings(ooHome);
  assert.equal(settings.activeWindow, "36h");
  assert.deepEqual(settings.skillPolicy, { mode: "allowlist", allowlist: ["calendar", "mail"] });
  assert.equal(settings.alwaysOn, "declined");
  assert.equal(installCalls, 0, "declining always-on never invokes the installer");
  assert.deepEqual(asked.slice(0, 4), [
    "Owner Operator",
    "Are there any coding projects or repositories you don’t want Owner Operator to interact with?",
    "Import existing standalone Pi setup?",
    "Agent session access",
  ], "privacy and model setup precede the single catalog review");
  assert.ok(asked.indexOf("Keep Owner Operator running?") < asked.indexOf("How far back counts as active?"), "always-on precedes the active window");

  const freshHome = join(root, "fresh-home");
  const freshPi = join(root, "fresh-pi");
  mkdirSync(freshPi, { recursive: true });
  let editorText = "";
  const freshUi = {
    async confirm(): Promise<boolean> { return true; },
    async input(): Promise<string> { return ""; },
    async select(): Promise<string | undefined> { return undefined; },
    notify(): void {},
    setEditorText(value: string): void { editorText = value; },
  };
  assert.equal(await runOnboarding({ hasUI: true, ui: freshUi } as any, { ooHome: freshHome, piAgentDir: freshPi }), false);
  assert.equal(editorText, "/login", "fresh setup hands authorization to Pi’s maintained login wizard");
  assert.ok(!JSON.parse(readFileSync(join(freshHome, "onboarded.json"), "utf8")).completed.includes("auth"), "auth remains pending until credentials exist");
  writeFileSync(join(freshHome, "pi", "auth.json"), JSON.stringify({ codex: { type: "api_key", key: "token" } }));
  editorText = "";
  assert.equal(await runOnboarding({ hasUI: true, ui: freshUi } as any, { ooHome: freshHome, piAgentDir: freshPi }), false);
  assert.equal(editorText, "/model", "after login, onboarding resumes at Pi’s model picker without replaying earlier steps");

  const declinedHome = join(root, "declined-home");
  const standalonePi = join(root, "standalone-pi");
  mkdirSync(standalonePi, { recursive: true });
  writeFileSync(join(standalonePi, "auth.json"), JSON.stringify({ codex: { type: "api_key", key: "standalone" } }));
  writeFileSync(join(standalonePi, "settings.json"), JSON.stringify({ defaultProvider: "codex", defaultModel: "gpt-test" }));
  let importOffers = 0;
  const declinedUi = {
    async confirm(title: string): Promise<boolean> {
      if (title === "Import existing standalone Pi setup?") { importOffers += 1; return false; }
      return true;
    },
    async input(): Promise<string> { return ""; },
    async select(): Promise<string | undefined> { return undefined; },
    notify(): void {},
    setEditorText(value: string): void { editorText = value; },
  };
  editorText = "";
  assert.equal(await runOnboarding({ hasUI: true, ui: declinedUi } as any, { ooHome: declinedHome, piAgentDir: standalonePi }), false);
  assert.equal(editorText, "/login");
  writeFileSync(join(declinedHome, "pi", "auth.json"), JSON.stringify({ codex: { type: "api_key", key: "owned" } }));
  editorText = "";
  assert.equal(await runOnboarding({ hasUI: true, ui: declinedUi } as any, { ooHome: declinedHome, piAgentDir: standalonePi }), false);
  assert.equal(editorText, "/model");
  assert.equal(importOffers, 1, "a declined standalone import is not asked again between login and model selection");

  const recoverHome = join(root, "recover-home");
  const recoverPi = join(recoverHome, "pi");
  mkdirSync(recoverPi, { recursive: true });
  writeFileSync(join(recoverPi, "auth.json"), JSON.stringify({ codex: { type: "api_key", key: "owned" } }));
  writeFileSync(join(recoverPi, "settings.json"), JSON.stringify({ defaultProvider: "codex", defaultModel: "removed-model" }));
  editorText = "";
  assert.equal(await runOnboarding({
    hasUI: true,
    ui: freshUi,
    modelRegistry: { find: () => undefined, getAvailable: () => [], hasConfiguredAuth: () => false },
  } as any, { ooHome: recoverHome, piAgentDir: standalonePi }), false);
  assert.equal(JSON.parse(readFileSync(join(recoverPi, "settings.json"), "utf8")).defaultModel, "gpt-test", "an unavailable owned selection does not suppress a valid standalone import");
  assert.equal(editorText, "/model", "the imported selection is still checked against the live registry");

  const staleHome = join(root, "stale-model-home");
  const staleOwnedPi = join(staleHome, "pi");
  mkdirSync(staleOwnedPi, { recursive: true });
  writeFileSync(join(staleOwnedPi, "auth.json"), JSON.stringify({ codex: { type: "api_key", key: "token" } }));
  writeFileSync(join(staleOwnedPi, "settings.json"), JSON.stringify({ defaultProvider: "codex", defaultModel: "removed-model" }));
  editorText = "";
  assert.equal(await runOnboarding({ hasUI: true, ui: freshUi } as any, {
    ooHome: staleHome,
    piAgentDir: staleOwnedPi,
    resolveModel: () => false,
  }), false);
  assert.equal(editorText, "/model", "a configured but unavailable model opens the embedded model picker");
  assert.ok(!JSON.parse(readFileSync(join(staleHome, "onboarded.json"), "utf8")).completed.includes("auth"));

  process.stdout.write("ok — onboarding flow writes every consent through the core config API\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}

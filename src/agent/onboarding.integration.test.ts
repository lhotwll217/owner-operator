import assert from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KNOWN_SESSION_SOURCES,
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

const confirms = [true, true, true, false, false]; // intro, Pi import, Codex root, deep search, always-on
const inputs = [blocked, "calendar, mail"];
const selects = ["Done", "36h", "Selected personal skills"];
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
  tier: 2,
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
  assert.deepEqual(configuredRoots, [{ source: "codex", root: codexRoot }]);
  const sourceConfig = JSON.parse(readFileSync(join(ooHome, "session_sources.json"), "utf8"));
  assert.deepEqual([...sourceConfig.disable].sort(), [...KNOWN_SESSION_SOURCES].sort(), "unconfirmed defaults are disabled");
  const settings = loadHarnessSettings(ooHome);
  assert.equal(settings.activeWindow, "36h");
  assert.deepEqual(settings.skillPolicy, { mode: "allowlist", allowlist: ["calendar", "mail"] });
  assert.equal(settings.alwaysOn, "declined");
  assert.equal(installCalls, 0, "declining always-on never invokes the installer");
  assert.deepEqual(asked.slice(0, 3), ["Owner Operator", "Anything off-limits?", "Import Pi setup?"], "privacy precedes source detection and import");

  process.stdout.write("ok — onboarding flow writes every consent through the core config API\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}

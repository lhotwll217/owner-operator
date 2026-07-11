import assert from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEvalModelSettings } from "../eval/providers/model-settings.mjs";

const root = mkdtempSync(join(tmpdir(), "oo-eval-model-settings-"));
try {
  const piDir = join(root, ".pi");
  mkdirSync(piDir);
  writeFileSync(join(piDir, "settings.example.json"), JSON.stringify({
    defaultProvider: "example-provider",
    defaultModel: "example-model",
  }));

  const fallback = loadEvalModelSettings(root);
  assert.equal(fallback.artifactPath, ".pi/settings.example.json");
  assert.equal(fallback.settings.defaultModel, "example-model");

  writeFileSync(join(piDir, "settings.json"), JSON.stringify({
    defaultProvider: "local-provider",
    defaultModel: "local-model",
  }));
  const local = loadEvalModelSettings(root);
  assert.equal(local.artifactPath, ".pi/settings.json");
  assert.equal(local.settings.defaultModel, "local-model");

  writeFileSync(join(piDir, "settings.json"), JSON.stringify({ defaultModel: "unpaired-model" }));
  assert.throws(
    () => loadEvalModelSettings(root),
    /defaultProvider and defaultModel are required/,
    "an eval model must be fully pinned instead of inheriting an ambient provider",
  );

  rmSync(join(piDir, "settings.json"));
  rmSync(join(piDir, "settings.example.json"));
  assert.throws(
    () => loadEvalModelSettings(root),
    /copy \.pi\/settings\.example\.json/i,
    "missing configuration has an actionable setup error",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write("ok — eval model settings: local config with committed-example fallback\n");

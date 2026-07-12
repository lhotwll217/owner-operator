import fs from "node:fs";
import path from "node:path";

export function loadEvalModelSettings(repoRoot) {
  const candidates = [".pi/settings.json", ".pi/settings.example.json"];
  for (const artifactPath of candidates) {
    const absolute = path.join(repoRoot, artifactPath);
    if (!fs.existsSync(absolute)) continue;
    try {
      const settings = JSON.parse(fs.readFileSync(absolute, "utf8"));
      if (!settings.defaultProvider || !settings.defaultModel) {
        throw new Error("defaultProvider and defaultModel are required");
      }
      return { settings, artifactPath };
    } catch (error) {
      throw new Error(`Invalid eval model settings in ${artifactPath}: ${error.message}`);
    }
  }
  throw new Error(
    "Eval model settings are missing. Restore .pi/settings.example.json, then copy .pi/settings.example.json to .pi/settings.json to customize the model.",
  );
}

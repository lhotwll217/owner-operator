import assert from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeFingerprint } from "./fingerprint";

const root = mkdtempSync(join(tmpdir(), "oo-fingerprint-"));
try {
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "packages", "core"), { recursive: true });
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, "src", "runtime.ts"), "export const version = 1;\n");
  const first = runtimeFingerprint(root);
  writeFileSync(join(root, "src", "runtime.ts"), "export const version = 2;\n");
  const second = runtimeFingerprint(root);
  assert.notEqual(second, first, "uncommitted runtime content changes identity");
  assert.equal(runtimeFingerprint(root), second, "unchanged content is stable");
  process.stdout.write("ok — runtime source fingerprint\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}

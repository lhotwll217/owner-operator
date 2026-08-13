import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { absoluteTsxLoaderPath } from "../shared/tsx-loader";

const root = mkdtempSync(join(tmpdir(), "oo-live-cleanup-test-"));
const isolatedTmp = join(root, "tmp");
const emptyPath = join(root, "empty-path");
const configSource = join(root, "config.toml");
mkdirSync(isolatedTmp);
mkdirSync(emptyPath);
writeFileSync(configSource, "");

try {
  const result = spawnSync(process.execPath, [
    "--import",
    absoluteTsxLoaderPath(),
    fileURLToPath(new URL("./delegated-identity.live.test.ts", import.meta.url)),
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: emptyPath,
      TMPDIR: isolatedTmp,
      OO_LIVE_IDENTITY_WORKER: "0",
      OO_RUN_LIVE_DELEGATED_IDENTITY: "1",
      OO_LIVE_IDENTITY_HARNESS: "codex",
      OO_LIVE_IDENTITY_MODEL: "never-launched",
      OO_LIVE_IDENTITY_EFFORT: "null",
      OO_LIVE_IDENTITY_CREDENTIAL_SOURCE: join(root, "missing-auth.json"),
      OO_LIVE_IDENTITY_CONFIG_SOURCE: configSource,
    },
  });

  assert.notEqual(result.status, 0, "failed setup exits nonzero");
  assert.match(result.stderr, /missing-auth\.json/, "reports the pre-daemon setup failure");
  assert.doesNotMatch(result.stderr, /\bps\b|ENOENT.*ps/, "does not enumerate processes before daemon creation");
  assert.deepEqual(
    readdirSync(isolatedTmp).filter((name) => name.startsWith("oo-live-delegated-identity-")),
    [],
    "removes the temporary home after pre-daemon failure without launching a daemon or provider",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

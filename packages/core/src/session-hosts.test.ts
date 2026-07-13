import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KNOWN_SESSION_HOSTS,
  SESSION_HOST_DESCRIPTORS,
  loadSessionHosts,
  sessionHostFor,
  sessionHostForCwd,
} from "./session-hosts.mjs";

const ooHome = mkdtempSync(join(tmpdir(), "oo-session-hosts-"));
const home = join(ooHome, "owner");

try {
  assert.deepEqual(KNOWN_SESSION_HOSTS, SESSION_HOST_DESCRIPTORS.map(({ id }) => id));
  assert.deepEqual(
    SESSION_HOST_DESCRIPTORS.filter(({ review }) => review).map(({ id, label }) => ({ id, label })),
    [
      { id: "superset", label: "Superset App" },
      { id: "conductor", label: "Conductor" },
      { id: "posthog-code", label: "PostHog Code" },
      { id: "claude-app", label: "Claude App" },
      { id: "claude-cli", label: "Claude CLI" },
      { id: "codex-app", label: "Codex App" },
      { id: "codex-cli", label: "Codex CLI" },
      { id: "cursor", label: "Cursor" },
      { id: "pi", label: "Pi" },
      { id: "opencode", label: "OpenCode" },
      { id: "antigravity", label: "Antigravity" },
      { id: "grok-build", label: "Grok Build" },
    ],
    "onboarding reviews apps and CLIs separately from harnesses; SDK transports stay internal",
  );

  const hosts = loadSessionHosts(ooHome, { home });
  assert.equal(sessionHostFor({ format: "claude", cwd: join(home, ".superset", "worktrees", "p", "w") }, hosts)?.id, "superset");
  assert.equal(sessionHostFor({ format: "codex", cwd: join(home, "conductor", "workspaces", "p", "w") }, hosts)?.id, "conductor");
  assert.equal(sessionHostFor({ format: "cursor", cwd: join(home, "conductor", "workspaces", "p", "w") }, hosts)?.id, "conductor");
  assert.equal(sessionHostFor({ format: "opencode", cwd: join(home, "conductor", "workspaces", "p", "w") }, hosts)?.id, "conductor");
  assert.equal(sessionHostFor({ format: "pi", cwd: join(home, "conductor", "workspaces", "p", "w") }, hosts)?.id, "pi", "a rooted host only claims harnesses it supports");
  assert.equal(sessionHostFor({ format: "claude", cwd: "/repo", entrypoint: "claude-desktop" }, hosts)?.id, "claude-app");
  assert.equal(sessionHostFor({ format: "claude", cwd: "/repo", entrypoint: "cli" }, hosts)?.id, "claude-cli");
  assert.equal(sessionHostFor({ format: "codex", cwd: "/repo", sourceHint: "vscode" }, hosts)?.id, "codex-app");
  assert.equal(sessionHostFor({ format: "codex", cwd: "/repo", originator: "codex_cli_rs" }, hosts)?.id, "codex-cli");

  writeFileSync(join(ooHome, "session_hosts.json"), JSON.stringify({
    roots: [{ host: "superset", root: "/Volumes/work/superset-home" }],
    add: [{ id: "my-host", label: "My Host", roots: ["/Volumes/work/my-host"] }],
  }));
  const configured = loadSessionHosts(ooHome, { home });
  assert.equal(sessionHostForCwd("/Volumes/work/superset-home/project/thread", configured)?.id, "superset");
  assert.equal(sessionHostFor({ format: "codex", cwd: "/Volumes/work/superset-home/project/thread" }, configured)?.id, "superset");
  assert.equal(sessionHostForCwd("/Volumes/work/superset-home-old/project", configured), null, "root matching uses path boundaries");
  assert.equal(sessionHostFor({ format: "codex", cwd: "/Volumes/work/my-host/project" }, configured)?.label, "My Host", "owner-defined rooted hosts accept any harness unless constrained");

  writeFileSync(join(ooHome, "gui_hosts.json"), JSON.stringify({ add: [{ ui: "My Claude Host", source: "claude" }] }));
  assert.equal(sessionHostFor({ format: "claude", cwd: "/repo" }, loadSessionHosts(ooHome, { home }))?.label, "My Claude Host", "legacy source host remains a format override");

  process.stdout.write("ok — session-hosts: stable catalog, app/CLI distinction, root precedence, custom roots\n");
} finally {
  rmSync(ooHome, { recursive: true, force: true });
}

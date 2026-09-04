// Product-owned Owner Operator sessions share the Pi parser but retain independent store
// attribution, automation classification, and scan capacity.
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_SESSION_SOURCES } from "@owner-operator/core";

const here = dirname(fileURLToPath(import.meta.url));
const scan = join(here, "scan-active-transcripts.mjs");
const home = mkdtempSync(join(tmpdir(), "oo-product-scan-home-"));
const ooHome = mkdtempSync(join(tmpdir(), "oo-product-scan-store-"));
const externalRoot = join(home, "external-pi");
const productRoot = join(ooHome, "sessions");
mkdirSync(externalRoot, { recursive: true });
mkdirSync(productRoot, { recursive: true });
writeFileSync(join(ooHome, "session_sources.json"), JSON.stringify({
  disable: KNOWN_SESSION_SOURCES,
  add: [{ source: "pi", root: externalRoot }],
}));

const at = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const writePi = (
  root: string,
  id: string,
  minutesAgo: number,
  provenance?: Record<string, unknown> | Record<string, unknown>[],
): void => {
  const file = join(root, `${id}.jsonl`);
  const stamps = provenance === undefined ? [] : Array.isArray(provenance) ? provenance : [provenance];
  writeFileSync(file, [
    { type: "session", version: 3, id, timestamp: at(minutesAgo + 2), cwd: "(unknown)" },
    ...stamps.map((data, index) => ({
      type: "custom", customType: "oo-provenance", timestamp: at(minutesAgo + 1 - index / 10), data,
    })),
    { type: "message", timestamp: at(minutesAgo + 1), message: { role: "user", content: `task ${id}` } },
    { type: "message", timestamp: at(minutesAgo), message: {
      role: "assistant", content: [{ type: "text", text: `done ${id}` }], stopReason: "stop",
    } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
};

for (let index = 0; index < 52; index += 1) {
  writePi(externalRoot, `external-${String(index).padStart(2, "0")}`, 100 + index);
  writePi(productRoot, `product-${String(index).padStart(2, "0")}`, 200 + index);
}

const ownerChatId = "owner-chat";
writePi(productRoot, ownerChatId, 1, [
  { surface: "chat", origin: "owner", callerCwd: "/tasks/old", callerRepo: "old-repo", ppid: 1 },
  { surface: "chat", origin: "owner", callerCwd: "/tasks/issue-131", callerRepo: "issue-131", ppid: 2 },
  { surface: "bogus", origin: "owner", callerCwd: "/tasks/wrong", callerRepo: "wrong", ppid: 3 },
]);
const ownerInteractiveId = "owner-interactive";
writePi(productRoot, ownerInteractiveId, 2, {
  surface: "interactive", origin: "owner", callerCwd: "/tasks/interactive", callerRepo: "interactive-task", ppid: 4,
});

const automated = [
  ["oo-schedule", { surface: "schedule", origin: "owner" }],
  ["oo-scheduler", { surface: "chat", origin: "scheduler" }],
  ["oo-agent", { surface: "chat", origin: "agent" }],
] as const;
for (const [id, identity] of automated) {
  writePi(productRoot, id, 3, {
    ...identity, callerCwd: `/tasks/${id}`, callerRepo: id, ppid: 5,
  });
}

interface ScanThread {
  id: string;
  source: string;
  namespace?: string;
  ui: string;
  repo: string;
  project: string;
  automated: boolean;
}
const run = (...args: string[]): { count: number; threads: ScanThread[] } => JSON.parse(execFileSync(
  process.execPath,
  [scan, "--since", "7d", "--json", ...args],
  { encoding: "utf8", env: { ...process.env, HOME: home, OO_HOME: ooHome } },
));

try {
  const visible = run("--limit", "50");
  const external = visible.threads.filter(({ namespace }) => namespace !== "owner-operator");
  const product = visible.threads.filter(({ namespace }) => namespace === "owner-operator");
  assert.equal(external.length, 50, "the existing external scan slice remains intact");
  assert.equal(product.length, 50, "OO roots receive a separate bounded scan slice");
  assert.equal(visible.count, 100, "the two independently bounded slices merge for monitoring");

  const chat = visible.threads.find(({ id }) => id === ownerChatId)!;
  assert.deepEqual(
    { source: chat.source, namespace: chat.namespace, app: chat.ui, repo: chat.repo, project: chat.project },
    {
      source: "pi", namespace: "owner-operator", app: "Owner Operator",
      repo: "issue-131", project: "/tasks/issue-131",
    },
    "the latest valid OO provenance controls task attribution while the parser format stays Pi",
  );
  assert.ok(visible.threads.some(({ id }) => id === ownerInteractiveId), "owner interactive sessions are roots");
  for (const [id] of automated) {
    assert.ok(!visible.threads.some((thread) => thread.id === id), `${id} stays out of owner-facing monitoring`);
    const direct = run("--thread", id);
    assert.equal(direct.threads[0]?.id, id, `${id} remains directly retrievable`);
    assert.equal(direct.threads[0]?.ui, "Owner Operator");
  }

  process.stdout.write("ok — OO product scan: provenance, automation, independent capacity, direct retrieval\n");
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(ooHome, { recursive: true, force: true });
}

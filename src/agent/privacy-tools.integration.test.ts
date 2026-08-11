// Integration: the supported Pi tool_call guard rejects blocked file paths while leaving
// built-in definitions available for pi-tool-display to own.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
  blacklistedPathVerdict,
  createPrivacyToolGuardExtension,
  guardOwnerOperatorToolCall,
} from "./privacy-tools";

const root = mkdtempSync(join(tmpdir(), "oo-privacy-tools-"));
const ooHome = join(root, "oo-home");
const publicDir = join(root, "public");
const privateDir = join(root, "Private");
const privateFile = join(privateDir, "secret.txt");
const linkedSecret = join(publicDir, "linked-secret.txt");
const linkedPrivateDir = join(publicDir, "linked-private");
const priorOoHome = process.env.OO_HOME;

const event = (toolName: string, input: Record<string, unknown>): ToolCallEvent => ({
  type: "tool_call",
  toolCallId: `${toolName}-call`,
  toolName,
  input,
} as ToolCallEvent);

try {
  process.env.OO_HOME = ooHome;
  mkdirSync(ooHome, { recursive: true });
  mkdirSync(publicDir, { recursive: true });
  mkdirSync(privateDir, { recursive: true });
  writeFileSync(join(ooHome, "blacklist.json"), JSON.stringify({ paths: [privateDir], repos: [] }));
  writeFileSync(privateFile, "SECRET\n");
  symlinkSync(privateFile, linkedSecret);
  symlinkSync(privateDir, linkedPrivateDir);

  assert.equal(
    blacklistedPathVerdict(privateFile, publicDir, { paths: [], repos: ["Private"] }).blacklisted,
    true,
    "direct guards enforce repository-name exclusions",
  );

  const directCases = [
    ["read", privateFile],
    ["read", linkedSecret],
    ["grep", privateDir],
    ["find", privateDir],
    ["ls", privateDir],
    ["edit", privateFile],
    ["write", join(privateDir, "new-secret.txt")],
    ["write", join(linkedPrivateDir, "through-link.txt")],
  ] as const;
  for (const [toolName, target] of directCases) {
    const result = guardOwnerOperatorToolCall(event(toolName, { path: target }), publicDir);
    assert.equal(result?.block, true, `${toolName} blocks ${target}`);
    assert.match(result?.reason ?? "", /blacklisted/);
  }

  // Pi 0.84.1 names the target `path` for every file primitive. Required-path tools fail
  // closed if a future schema reaches this hook without that recognized target.
  for (const toolName of ["read", "edit", "write"] as const) {
    const result = guardOwnerOperatorToolCall(event(toolName, {}), publicDir);
    assert.equal(result?.block, true, `${toolName} fails closed without its required path`);
    assert.match(result?.reason ?? "", /requires a path/);
  }
  assert.equal(
    guardOwnerOperatorToolCall(event("constructor", { path: privateFile }), publicDir),
    undefined,
    "inherited object keys are not mistaken for guarded Pi tool names",
  );

  for (const toolName of ["grep", "find", "ls"] as const) {
    const result = guardOwnerOperatorToolCall(event(toolName, { path: root }), publicDir);
    assert.equal(result?.block, true, `${toolName} blocks traversal through a blacklisted child`);
    assert.match(result?.reason ?? "", /would traverse blacklisted path/);
  }

  assert.equal(
    guardOwnerOperatorToolCall(event("read", { path: join(publicDir, "safe.txt") }), publicDir),
    undefined,
    "allowed paths pass through to Pi's built-in tool",
  );

  let registered: ((event: ToolCallEvent, ctx: { cwd: string }) => unknown) | undefined;
  createPrivacyToolGuardExtension({ callerSessionId: "caller'id" })({
    on(name: string, handler: typeof registered): void {
      assert.equal(name, "tool_call");
      registered = handler;
    },
  } as never);
  assert.ok(registered, "the policy is installed on Pi's supported tool_call hook");
  const bash = event("bash", { command: "printf command-ok" });
  assert.equal(registered!(bash, { cwd: publicDir }), undefined);
  const command = (bash.input as { command: string }).command;
  const output = execFileSync("/bin/sh", ["-c", `${command}; printf '|%s|%s' "$OO_INSTALL_ROOT" "$OO_CALLER_SESSION_ID"`], {
    encoding: "utf8",
  });
  assert.match(output, /^command-ok\|.+\|caller'id$/,
    "the guard preserves the original Bash command and injects shell-safe OO provenance");

  process.stdout.write("ok — privacy guard: supported tool_call preflight blocks every Pi file primitive\n");
} finally {
  if (priorOoHome === undefined) delete process.env.OO_HOME;
  else process.env.OO_HOME = priorOoHome;
  rmSync(root, { recursive: true, force: true });
}

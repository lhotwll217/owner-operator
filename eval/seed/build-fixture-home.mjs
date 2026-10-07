// Build the eval sandbox: fixture transcripts + a seeded OO_HOME, both under
// $TMPDIR/oo-eval-sandbox/<run-id> (outside the repo), so concurrent runs never share state
// and a subject's session sources never point at repo files. The eval directory itself is
// blacklisted for subjects, making cases.yaml
// and fixture ground truth structurally unreadable while leaving the shipped skill loadable.
//
//   npx tsx eval/seed/build-fixture-home.mjs        (idempotent; prints the sandbox path)
//
// Layout under $TMPDIR/oo-eval-sandbox/<run-id>:
//   transcripts/claude/<project-slug>/<id>.jsonl    claude-format sessions
//   transcripts/codex/<id>.jsonl                    codex-format sessions
//   home/                                           OO_HOME for the subject under eval:
//     sessions/<id>.jsonl                           saved Owner Operator sessions
//     session_sources.json                          defaults disabled, fixture roots added
//     settings.json                                 activeWindow wide enough for the fixtures
//     state.db                                      versioned state + details history
//
// Timestamps come from fixtures/sessions.mjs offsets, materialized relative to NOW — so
// "active today" behaves identically on every run. Run again to re-stamp before an eval.

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { markOnboarded, ownerOperatorPaths, savePermissionMode } from "@owner-operator/core";
import { assertEvalSandboxPath, evalSandboxPath } from "../sandbox.mjs";
import { seedFixtureSessions } from "./fixture-sessions.mjs";
import { repoRoot } from "../../src/shared/repo-root.ts";

export const SANDBOX = process.env.OO_EVAL_SANDBOX
  ? assertEvalSandboxPath(process.env.OO_EVAL_SANDBOX)
  : evalSandboxPath("manual");
const TRANSCRIPTS = join(SANDBOX, "transcripts");
const HOME = join(SANDBOX, "home");

rmSync(SANDBOX, { recursive: true, force: true });
mkdirSync(join(TRANSCRIPTS, "codex"), { recursive: true });
mkdirSync(HOME, { recursive: true });

const { sessionSources } = seedFixtureSessions({ root: SANDBOX, ooHome: HOME });

// ---- OO_HOME: sources, settings, seeded db ------------------------------------------
writeFileSync(join(HOME, "session_sources.json"), JSON.stringify(sessionSources, null, 2));
writeFileSync(join(HOME, "settings.json"), JSON.stringify({ activeWindow: "14d" }, null, 2));
writeFileSync(join(HOME, "blacklist.json"), JSON.stringify({ paths: [join(repoRoot, "eval")], repos: [] }, null, 2));
markOnboarded(HOME, { via: "eval-fixture" });

// Embedded Pi roots auth and model settings under OO_HOME/pi; seed them from the
// developer's real home so eval subjects can call the model.
const real = ownerOperatorPaths();
const sandboxPi = ownerOperatorPaths(HOME);
for (const key of ["piAuth", "piSettings", "piModels"]) {
  if (!existsSync(real[key])) continue;
  mkdirSync(sandboxPi.piAgentDir, { recursive: true });
  cpSync(real[key], sandboxPi[key]);
}

// The default permission mode is read-only, which denies shell commands; eval subjects
// need bash for transcript search and `oo` reads. Bash also reaches `oo` verbs that change
// state, and every case shares this fixture DB, so owner rules deny them (owner rules follow
// the `oo` allow rules and win; adr/0001-agent-uses-its-own-cli.md).
const permissions = savePermissionMode(HOME, "allow");
const OO_STATE_CHANGES = [
  "oo session-state done *",
  "oo schedules create *", "oo schedules update *", "oo schedules delete *",
  "oo schedules disable *", "oo schedules run *",
  "oo runs delegate *", "oo runs cancel *", "oo runs retry *", "oo runs resume *",
  "oo harness approve *",
  "oo worktrees create *", "oo worktrees select *",
  "oo skill install *", "oo skill uninstall *",
];
for (const rule of OO_STATE_CHANGES) permissions.permission.bash[rule] = "deny";
writeFileSync(ownerOperatorPaths(HOME).piPermissionConfig, `${JSON.stringify(permissions, null, 2)}\n`);


console.log(SANDBOX);

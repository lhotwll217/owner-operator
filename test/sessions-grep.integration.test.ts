// Integration: the real sessions-grep script enforces the privacy blacklist. A match inside a
// blacklisted tree is never returned (both layers: project-dir slug, and post-parse cwd); a match
// in a normal repo is. Also: oo's own threads live under <OO_HOME>/sessions and are found
// by pointing the vendored primitive at that directory as typed pi sessions — never via the
// wrapper's default `all` search. Needs ripgrep, like the skill — skips cleanly if absent.
import assert from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (spawnSync("rg", ["--version"], { stdio: "ignore" }).status !== 0) {
  process.stdout.write("skip — ripgrep (rg) not installed; sessions-grep blacklist test needs it\n");
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const GREP = join(here, "..", "src/agent/skills/session-search/scripts/session-search.mjs");
const VENDORED_GREP = join(here, "..", "src/agent/skills/session-search/vendor/session-grep/session-grep.mjs");

const primitiveSelfTest = spawnSync(process.execPath, [VENDORED_GREP, "--self-test"], { encoding: "utf8" });
assert.equal(
  primitiveSelfTest.status,
  0,
  `vendored session-grep self-test failed:\n${primitiveSelfTest.stderr || primitiveSelfTest.stdout}`,
);

const home = mkdtempSync(join(tmpdir(), "oo-grep-home-"));
const ooHome = mkdtempSync(join(tmpdir(), "oo-grep-oohome-"));
try {
  const NEEDLE = "ZZUNIQUENEEDLEZZ";
  const claudeMsg = (id: string, cwd: string, text: string) =>
    JSON.stringify({ type: "user", sessionId: id, cwd, timestamp: "2026-06-30T10:00:00.000Z", message: { content: text } }) + "\n";
  const slugOf = (cwd: string) => cwd.replace(/[^A-Za-z0-9-]/g, "-");
  const writeSession = (dir: string, id: string, cwd: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), claudeMsg(id, cwd, `here is the ${NEEDLE} you want`));
  };

  const privateRoot = join(home, "Documents", "Private");
  writeFileSync(join(ooHome, "blacklist.json"), JSON.stringify({ paths: [privateRoot], repos: [] }));

  // Visible: normal repo, project dir slugged from its cwd.
  const okId = "okokokok-1111-2222-3333-444444444444";
  const okCwd = join(home, "dev", "normal-repo");
  const okDir = join(home, ".claude", "projects", slugOf(okCwd));
  writeSession(okDir, okId, okCwd);

  // Enough repeated hits to prove the policy wrapper preserves the requested aperture while
  // fetching extra candidates for its second blacklist layer.
  const budgetNeedle = "ZZBUDGETNEEDLEZZ";
  const budgetId = "budgetxx-1111-2222-3333-444444444444";
  writeFileSync(
    join(okDir, `${budgetId}.jsonl`),
    Array.from({ length: 12 }, (_, index) =>
      claudeMsg(budgetId, okCwd, `${budgetNeedle} hit ${index} ${"bounded context ".repeat(35)}`),
    ).join(""),
  );

  const previewNeedle = "ZZQUIXOTICPREVIEWZZ";
  const previewTail = "FINAL-WRAPPER-DECISION";
  const previewId = "previewx-1111-2222-3333-444444444444";
  writeFileSync(
    join(okDir, `${previewId}.jsonl`),
    claudeMsg(previewId, okCwd, `${previewNeedle} searching for --units must work ${"bounded context ".repeat(30)}${previewTail}`),
  );

  // Blocked by layer 1: project-dir slug is under the blacklisted tree.
  const slugId = "slugslug-1111-2222-3333-444444444444";
  const slugCwd = join(privateRoot, "Career");
  writeSession(join(home, ".claude", "projects", slugOf(slugCwd)), slugId, slugCwd);

  // Blocked by layer 2: dir name is NOT slugged to the tree, but the record's cwd is inside it.
  const cwdId = "cwdcwdcw-1111-2222-3333-444444444444";
  const cwdCwd = join(privateRoot, "Jobs", "acme");
  writeSession(join(home, ".claude", "projects", "misc"), cwdId, cwdCwd);

  // oo's own threads (pi session format) in the separate Owner Operator dir.
  const ownerOperatorDir = join(ooHome, "sessions");
  mkdirSync(ownerOperatorDir, { recursive: true });
  const writeOwnerOperatorSession = (id: string) =>
    writeFileSync(
      join(ownerOperatorDir, `${id}.jsonl`),
      JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-06-30T10:00:00.000Z", cwd: join(home, "dev", "normal-repo") }) + "\n" +
        JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-06-30T10:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: `I already reported the ${NEEDLE} thread` }] } }) + "\n",
    );
  const ownerOperatorId = "owneropr-1111-2222-3333-444444444444";
  const otherOwnerOperatorId = "ooother-1111-2222-3333-444444444444";
  writeOwnerOperatorSession(ownerOperatorId);
  writeOwnerOperatorSession(otherOwnerOperatorId);

  // Codex indexes and deep links use the canonical UUID from session_meta, while the
  // transcript filename includes a rollout timestamp. The wrapper must accept the DB id.
  const codexId = "0198a111-2222-7333-8444-555555555555";
  const codexDir = join(home, ".codex", "sessions", "2026", "07", "10");
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(
    join(codexDir, `rollout-2026-07-10T08-30-00-${codexId}.jsonl`),
    JSON.stringify({ type: "session_meta", timestamp: "2026-07-10T08:30:00.000Z", payload: { id: codexId, cwd: okCwd, originator: "codex_cli" } }) + "\n" +
      JSON.stringify({ type: "response_item", timestamp: "2026-07-10T08:30:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "check the Codex UUID route" }] } }) + "\n" +
      JSON.stringify({ type: "response_item", timestamp: "2026-07-10T08:30:02.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Codex UUID route works" }] } }) + "\n",
  );

  const run = (...extra: string[]): { id: string; source?: string }[] => {
    const out = execFileSync(process.execPath, [GREP, "--query", NEEDLE, "--json", ...extra], {
      env: { ...process.env, HOME: home, OO_HOME: ooHome },
      encoding: "utf8",
    });
    return JSON.parse(out).matches;
  };
  const runOwnerOperator = (): { id: string; source?: string }[] => {
    const out = execFileSync(process.execPath, [GREP, "--query", NEEDLE, "--json", "--owner-operator"], {
      env: { ...process.env, HOME: home, OO_HOME: ooHome },
      encoding: "utf8",
    });
    return JSON.parse(out).matches;
  };
  const skim = (...extra: string[]) => execFileSync(process.execPath, [GREP, "--skim", codexId, ...extra], {
    env: { ...process.env, HOME: home, OO_HOME: ooHome },
    encoding: "utf8",
  });
  const idsOf = (ms: { id: string }[]) => ms.map((m) => m.id);

  const ids = idsOf(run("--target-type", "claude"));
  assert.ok(ids.includes(okId), "normal-repo match is returned");
  assert.ok(!ids.includes(slugId), "blacklisted project-dir slug (layer 1) is excluded");
  assert.ok(!ids.includes(cwdId), "blacklisted cwd tree (layer 2) is excluded");
  assert.ok(idsOf(run("--source", "claude")).includes(okId), "wrapper preserves the upstream --source compatibility alias");

  assert.ok(!idsOf(run()).includes(ownerOperatorId), "Owner Operator sessions stay out of the wrapper's default `all` search");
  const ownerOperatorMatches = runOwnerOperator();
  assert.deepEqual(
    idsOf(ownerOperatorMatches).sort(),
    [ownerOperatorId, otherOwnerOperatorId].sort(),
    "the skill policy points the primitive at Owner Operator sessions",
  );
  assert.ok(ownerOperatorMatches.every((m) => m.source === "pi"), "Owner Operator sessions are just pi-format sessions to the primitive");
  assert.match(skim("--target-type", "codex"), new RegExp(`skim id=${codexId}`), "DB canonical Codex UUID resolves its rollout file");
  const any = JSON.parse(execFileSync(process.execPath, [GREP, "--query", `${NEEDLE} NEVERMATCHES`, "--any", "--json", "--target-type", "claude"], {
    env: { ...process.env, HOME: home, OO_HOME: ooHome },
    encoding: "utf8",
  }));
  assert.ok(idsOf(any.matches).includes(okId), "--any exposes upstream rarity-ranked multi-term search");
  const pipeAny = JSON.parse(execFileSync(process.execPath, [GREP, "--query", `${NEEDLE}|NEVERMATCHES`, "--any", "--json", "--target-type", "claude"], {
    env: { ...process.env, HOME: home, OO_HOME: ooHome },
    encoding: "utf8",
  }));
  assert.deepEqual(
    pipeAny.wordHits,
    { [NEEDLE.toLowerCase()]: 2, nevermatches: 0 },
    "wrapper preserves the primitive's pipe-delimited --any terms and feedback",
  );
  for (const [role, expectedRoles] of Object.entries({
    user: ["user"],
    assistant: ["assistant"],
    all: ["assistant", "user"],
  })) {
    const roleFiltered = JSON.parse(execFileSync(
      process.execPath,
      [GREP, "--query", "Codex UUID route", "--role", role, "--json", "--target-type", "codex"],
      { env: { ...process.env, HOME: home, OO_HOME: ooHome }, encoding: "utf8" },
    ));
    assert.deepEqual(
      roleFiltered.matches.map((match: { match: { role: string } }) => match.match.role).sort(),
      expectedRoles,
      `wrapper preserves upstream --role ${role} filtering`,
    );
  }
  const invalidRole = spawnSync(
    process.execPath,
    [GREP, "--query", NEEDLE, "--role", "system", "--target-type", "claude"],
    { env: { ...process.env, HOME: home, OO_HOME: ooHome }, encoding: "utf8" },
  );
  assert.equal(invalidRole.status, 1, "wrapper rejects an invalid --role value");
  assert.match(invalidRole.stderr, /--role must be all, user, or assistant/, "wrapper preserves upstream --role validation");
  const leadingDashQuery = JSON.parse(execFileSync(
    process.execPath,
    [GREP, "--query", "--units", "--json", "--target-type", "claude"],
    { env: { ...process.env, HOME: home, OO_HOME: ooHome }, encoding: "utf8" },
  ));
  assert.ok(idsOf(leadingDashQuery.matches).includes(previewId), "wrapper accepts a literal query beginning with dashes");
  const anyText = execFileSync(process.execPath, [GREP, "--query", `${NEEDLE} NEVERMATCHES`, "--any", "--target-type", "claude"], {
    env: { ...process.env, HOME: home, OO_HOME: ooHome },
    encoding: "utf8",
  });
  assert.match(anyText, /word_hits:.*NEVERMATCHES=0/i, "text output preserves IDF feedback from the primitive");
  assert.match(anyText, /matched=\[/, "text output preserves per-hit matched terms and rank");
  const preview = JSON.parse(execFileSync(
    process.execPath,
    [GREP, "--query", previewNeedle, "--before", "0", "--after", "0", "--limit", "2", "--max-chars", "4000", "--json", "--target-type", "claude"],
    { env: { ...process.env, HOME: home, OO_HOME: ooHome }, encoding: "utf8" },
  ));
  const previewMatch = preview.matches.find((match: { id: string }) => match.id === previewId);
  assert.ok(previewMatch, "wrapper returns the matching session");
  assert.match(previewMatch.match.text, new RegExp(previewTail), "wrapper preserves a complete short message when it fits the aperture");
  const inlineCase = JSON.parse(execFileSync(
    process.execPath,
    [GREP, "--query", `(?i)${previewNeedle.toLowerCase()}`, "--regex", "--json", "--target-type", "claude"],
    { env: { ...process.env, HOME: home, OO_HOME: ooHome }, encoding: "utf8" },
  ));
  assert.ok(idsOf(inlineCase.matches).includes(previewId), "wrapper accepts the common leading (?i) regex modifier");
  const boundedText = execFileSync(process.execPath, [GREP, "--query", budgetNeedle, "--max-chars", "1200", "--target-type", "claude"], {
    env: { ...process.env, HOME: home, OO_HOME: ooHome },
    encoding: "utf8",
  });
  assert.ok(Buffer.byteLength(boundedText) <= 1200, "wrapper does not expand the primitive's requested output aperture while overfetching");
  const selfQuery = JSON.parse(execFileSync(process.execPath, [GREP, "--query", "Codex UUID route", "--json", "--target-type", "codex"], {
    env: { ...process.env, HOME: home, OO_HOME: ooHome, OO_CALLER_SESSION_ID: codexId },
    encoding: "utf8",
  }));
  assert.equal(selfQuery.callerSessionExclusion.applied, true, "query output makes caller exclusion explicit");
  assert.equal(selfQuery.callerSessionExclusion.sessionId, codexId, "query output names the excluded caller");
  assert.deepEqual(selfQuery.excludedSessions, [codexId], "wrapper delegates stable-id exclusion to the shared primitive");
  assert.ok(!idsOf(selfQuery.matches).includes(codexId), "discovery excludes the calling coding session");
  const selfQueryText = execFileSync(process.execPath, [GREP, "--query", "Codex UUID route", "--target-type", "codex"], {
    env: { ...process.env, HOME: home, OO_HOME: ooHome, OO_CALLER_SESSION_ID: codexId },
    encoding: "utf8",
  });
  assert.match(selfQueryText, new RegExp(`caller_session_exclusion=applied:${codexId}`), "text output explains discovery exclusion");
  for (const flagLikeQuery of ["--session", "--skim"]) {
    const flagLike = JSON.parse(execFileSync(
      process.execPath,
      [GREP, "--query", flagLikeQuery, "--json", "--target-type", "codex"],
      { env: { ...process.env, HOME: home, OO_HOME: ooHome, OO_CALLER_SESSION_ID: codexId }, encoding: "utf8" },
    ));
    assert.equal(
      flagLike.callerSessionExclusion.applied,
      true,
      `a ${flagLikeQuery} query value is not mistaken for a navigation flag`,
    );
  }
  const policyFilteredCandidates = JSON.parse(execFileSync(
    process.execPath,
    [GREP, "--query", NEEDLE, "--candidates", "--json", "--target-type", "claude"],
    { env: { ...process.env, HOME: home, OO_HOME: ooHome, OO_CALLER_SESSION_ID: "different-caller" }, encoding: "utf8" },
  ));
  assert.equal(policyFilteredCandidates.totalCandidateSessions, undefined, "a post-policy total is not guessed after cwd filtering");
  assert.ok(policyFilteredCandidates.totalCandidateSessionsBeforePolicy >= 2, "the primitive's pre-policy count remains explicit");
  assert.equal(policyFilteredCandidates.candidateSessionsAfterPolicyAtLeast, 1, "the wrapper exposes the safe visible lower bound");
  const policyFilteredText = execFileSync(
    process.execPath,
    [GREP, "--query", NEEDLE, "--candidates", "--target-type", "claude"],
    { env: { ...process.env, HOME: home, OO_HOME: ooHome, OO_CALLER_SESSION_ID: "different-caller" }, encoding: "utf8" },
  );
  assert.match(policyFilteredText, /candidate_sessions_at_least=1/, "candidate text labels the post-policy count as a lower bound");
  assert.match(policyFilteredText, /pre_policy_candidate_sessions=/, "candidate text keeps the primitive total without calling it available");
  const candidates = JSON.parse(execFileSync(
    process.execPath,
    [GREP, "--query", "Codex UUID route", "--candidates", "--json", "--target-type", "codex"],
    { env: { ...process.env, HOME: home, OO_HOME: ooHome, OO_CALLER_SESSION_ID: "different-caller" }, encoding: "utf8" },
  ));
  assert.equal(candidates.matches, undefined, "candidate mode does not return repeated message-hit payloads");
  assert.equal(candidates.candidates.length, 1, "two matching messages collapse to one session candidate");
  assert.equal(candidates.totalCandidateSessions, 1, "candidate count is computed before output limiting");
  assert.equal(candidates.candidates[0].id, codexId, "candidate retains the stable session pointer");
  assert.equal(candidates.candidates[0].hitCount, 2, "candidate reports every matching hit collapsed into the session");
  assert.equal(candidates.candidates[0].repo, "normal-repo", "candidate includes the project label available from the transcript header");
  const candidateText = execFileSync(
    process.execPath,
    [GREP, "--query", "Codex UUID route", "--candidates", "--target-type", "codex"],
    { env: { ...process.env, HOME: home, OO_HOME: ooHome, OO_CALLER_SESSION_ID: "different-caller" }, encoding: "utf8" },
  );
  assert.match(candidateText, /candidate_sessions=1/, "candidate text names the grouped aperture");
  assert.match(candidateText, /hits=2/, "candidate text exposes collapsed-hit evidence");
  assert.match(candidateText, new RegExp(`id=${codexId}.*best_idx=`), "candidate text exposes a drill-in pointer");
  const directKnownId = execFileSync(process.execPath, [GREP, "--skim", codexId, "--target-type", "codex"], {
    env: { ...process.env, HOME: home, OO_HOME: ooHome, OO_CALLER_SESSION_ID: codexId },
    encoding: "utf8",
  });
  assert.match(directKnownId, new RegExp(`skim id=${codexId}`), "discovery-only exclusion does not change ordinary known-ID browsing");
  const pointer = execFileSync(process.execPath, [GREP, "--session", okId, "--at", "0", "--target-type", "claude"], {
    env: { ...process.env, HOME: home, OO_HOME: ooHome },
    encoding: "utf8",
  });
  assert.match(pointer, new RegExp(`window id=${okId}`), "a hit's id/index can be drilled without re-querying");
  const scoped = JSON.parse(execFileSync(process.execPath, [GREP, "--query", NEEDLE, "--session", okId, "--json", "--target-type", "claude"], {
    env: { ...process.env, HOME: home, OO_HOME: ooHome },
    encoding: "utf8",
  }));
  assert.equal(scoped.session, okId, "known-ID query reports its exact session scope");
  assert.deepEqual(idsOf(scoped.matches), [okId], "known-ID query stays inside that transcript instead of rediscovering globally");
  const scopedText = execFileSync(process.execPath, [GREP, "--query", NEEDLE, "--session", okId, "--target-type", "claude"], {
    env: { ...process.env, HOME: home, OO_HOME: ooHome },
    encoding: "utf8",
  });
  assert.match(scopedText, new RegExp(`session=${okId}`), "scoped text makes the stable session boundary explicit");
  assert.match(scopedText, /caller_session_exclusion=not-needed:explicit-session-scope/, "explicit navigation is distinguished from unavailable caller provenance");
  const scopedOmitted = execFileSync(process.execPath, [GREP, "--query", budgetNeedle, "--session", budgetId, "--sort", "oldest", "--max-chars", "1200", "--target-type", "claude"], {
    env: { ...process.env, HOME: home, OO_HOME: ooHome },
    encoding: "utf8",
  });
  assert.match(scopedOmitted, /stay in this --session scope/, "wrapper preserves actionable omission feedback from a scoped query");
  const wrongRoot = spawnSync(process.execPath, [GREP, "--query", NEEDLE, "--target-root", okCwd], {
    env: { ...process.env, HOME: home, OO_HOME: ooHome },
    encoding: "utf8",
  });
  assert.equal(wrongRoot.status, 1);
  assert.match(wrongRoot.stderr, /configured session source/, "a project cwd is rejected as a transcript source root");
  process.stdout.write("ok — sessions-grep: blacklist layers hold; Owner Operator sessions use typed sources + target-root\n");
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(ooHome, { recursive: true, force: true });
}

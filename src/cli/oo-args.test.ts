// Unit: oo argv parsing. Free-form prompt, a few known flags. No model, no disk.
import assert from "node:assert";
import { parseOoArgs } from "./oo-args";

// --help / -h anywhere (so the caller can exit before building a session).
assert.equal(parseOoArgs(["--help"]).help, true, "--help");
assert.equal(parseOoArgs(["what's up", "-h"]).help, true, "-h after prompt");
assert.equal(parseOoArgs(["hello"]).help, false, "no help flag");

// `daemon` is a subcommand only as the FIRST token.
assert.equal(parseOoArgs(["daemon"]).daemon, true, "daemon subcommand");
assert.equal(parseOoArgs(["what about the daemon"]).daemon, false, "daemon only at argv[0]");

// --session-state is recognized and stripped from the prompt; old --json fails fast elsewhere.
const st = parseOoArgs(["--session-state", "what", "needs", "me"]);
assert.deepEqual([st.sessionState, st.prompt], [true, "what needs me"], "--session-state flag stripped from prompt");
assert.equal(parseOoArgs(["--json"]).removedJson, true, "old --json spelling is recognized for a rename error");
for (const spelling of [["one", "shot"].join("-"), ["one", "shot"].join("")]) {
  assert.equal(parseOoArgs([spelling, "what"]).removedHeadlessSubcommand, true, "removed headless subcommand is recognized for a removal error");
}

const c = parseOoArgs(["--continue", "and", "the", "tests?"]);
assert.deepEqual([c.continue, c.prompt], [true, "and the tests?"], "--continue stripped from prompt");
assert.equal(parseOoArgs(["-c", "more"]).continue, true, "-c alias");
assert.equal(parseOoArgs(["--continue", "-i"]).interactive, true, "-i recognized anywhere");
assert.deepEqual([parseOoArgs(["--interactive"]).interactive, parseOoArgs(["--interactive"]).prompt], [true, ""], "--interactive stripped from prompt");

const s = parseOoArgs(["--session", "abc123", "what", "next"]);
assert.deepEqual([s.session, s.prompt], ["abc123", "what next"], "--session takes the next token");
assert.equal(parseOoArgs(["hi", "--session"]).missingSession, true, "--session with no value is tracked");
assert.equal(parseOoArgs(["hi", "--session", "--continue"]).missingSession, true, "--session before another flag is tracked as missing");

const f = parseOoArgs(["--from-session", "sess-9", "--continue", "status?"]);
assert.deepEqual([f.fromSession, f.continue, f.prompt], ["sess-9", true, "status?"], "--from-session composes with resume flags");
assert.equal(parseOoArgs(["--from-session"]).missingFromSession, true, "--from-session with no value is tracked");

// --done collects ids up to the next flag; empty = ids missing (caller errors with usage).
const d = parseOoArgs(["--done", "id-1", "id-2"]);
assert.deepEqual(d.done, ["id-1", "id-2"], "--done collects multiple ids");
assert.deepEqual(parseOoArgs(["--done"]).done, [], "--done with no ids → empty array for the usage error");
assert.deepEqual(parseOoArgs(["--done", "--continue"]).done, [], "--done stops at the next flag");
assert.equal(parseOoArgs(["what", "needs", "me"]).done, undefined, "no --done → undefined");

// Unknown option-like tokens stay in the free-form prompt (the P2 regression codex caught).
assert.equal(parseOoArgs(["what", "changed", "--since", "today"]).prompt, "what changed --since today", "unknown flags preserved in prompt");

// No args → empty prompt (interactive REPL).
assert.equal(parseOoArgs([]).prompt, "", "no args → empty prompt");

process.stdout.write("ok — oo args: help/-h, daemon, fail-fast removals, --session-state, resume flags, free-form flags preserved\n");

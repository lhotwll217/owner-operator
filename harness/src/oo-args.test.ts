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

// --json is recognized and stripped from the prompt.
const j = parseOoArgs(["--json", "what", "needs", "me"]);
assert.deepEqual([j.json, j.prompt], [true, "what needs me"], "--json flag stripped from prompt");

// Unknown option-like tokens stay in the free-form prompt (the P2 regression codex caught).
assert.equal(parseOoArgs(["what", "changed", "--since", "today"]).prompt, "what changed --since today", "unknown flags preserved in prompt");

// No args → empty prompt (interactive REPL).
assert.equal(parseOoArgs([]).prompt, "", "no args → empty prompt");

process.stdout.write("ok — oo args: help/-h, daemon at argv[0], --json strip, free-form flags preserved\n");

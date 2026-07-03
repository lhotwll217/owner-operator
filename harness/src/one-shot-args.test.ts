// Unit: one-shot argv parsing. Session flags recognized anywhere; everything else is prompt.
import assert from "node:assert";
import { parseOneShotArgs } from "./one-shot-args";

assert.deepEqual(parseOneShotArgs(["what's ongoing?"]), { continue: false, session: undefined, prompt: "what's ongoing?" });
assert.deepEqual(parseOneShotArgs([]), { continue: false, session: undefined, prompt: "" });

const c = parseOneShotArgs(["--continue", "and", "the", "tests?"]);
assert.deepEqual([c.continue, c.prompt], [true, "and the tests?"], "--continue stripped from prompt");
assert.equal(parseOneShotArgs(["-c", "more"]).continue, true, "-c alias");

const s = parseOneShotArgs(["--session", "abc123", "what", "next"]);
assert.deepEqual([s.session, s.prompt], ["abc123", "what next"], "--session takes the next token");
assert.equal(parseOneShotArgs(["hi", "--session"]).session, undefined, "--session with no value stays unset");

assert.equal(parseOneShotArgs(["what", "changed", "--since", "today"]).prompt, "what changed --since today", "unknown flags preserved in prompt");

process.stdout.write("ok — one-shot args: prompt passthrough, --continue/-c, --session value\n");

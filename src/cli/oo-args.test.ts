// Unit: oo argv grammar. Reserved nouns, -p prompt, removed spellings. No model, no disk.
import assert from "node:assert";
import { OPERATION_NOUNS, parseOoArgs } from "./oo-args";

assert.deepEqual(parseOoArgs([]), { kind: "interactive" }, "bare oo is interactive");
assert.deepEqual(parseOoArgs(["-i"]), { kind: "interactive" }, "-i alias");
assert.deepEqual(parseOoArgs(["--help"]), { kind: "help" });
assert.deepEqual(parseOoArgs(["-p", "hi", "-h"]), { kind: "help" }, "help anywhere outside an operation");
assert.deepEqual(parseOoArgs(["doctor"]), { kind: "doctor" });
assert.deepEqual(parseOoArgs(["status"]), { kind: "doctor" }, "status aliases doctor");
assert.deepEqual(parseOoArgs(["daemon"]), { kind: "daemon" });

// Every reserved noun is an operation; its argv (including --help/--json) belongs to the noun.
for (const noun of OPERATION_NOUNS) {
  assert.deepEqual(parseOoArgs([noun, "list", "--json", "--help"]), { kind: "operation", noun, argv: ["list", "--json", "--help"] });
}

// -p carries the prompt; resume flags compose beside it.
assert.deepEqual(parseOoArgs(["-p", "what changed"]), { kind: "chat", continue: false, prompt: "what changed" });
assert.deepEqual(
  parseOoArgs(["--from-session", "sess-9", "--continue", "--prompt", "status?"]),
  { kind: "chat", continue: true, prompt: "status?", fromSession: "sess-9" },
);
assert.deepEqual(parseOoArgs(["--session", "abc", "-p", "next"]), { kind: "chat", continue: false, session: "abc", prompt: "next" });
assert.deepEqual(parseOoArgs(["-c"]), { kind: "chat", continue: true }, "resume without -p opens the REPL");

const usage = (argv: string[]): string => {
  const parsed = parseOoArgs(argv);
  assert.equal(parsed.kind, "usage-error", `${argv.join(" ")} is a usage error`);
  return (parsed as { message: string }).message;
};
assert.match(usage(["what", "changed"]), /unknown command "what".*oo -p "what changed"/, "bare prompt names -p");
assert.match(usage(["--since", "today"]), /Unknown option '--since'/, "unknown flag is an error, not prompt text");
assert.match(usage(["--session-state"]), /oo session-state list/);
assert.match(usage(["--done", "id-1"]), /oo session-state done <id\.\.\.>/);
assert.match(usage(["--json"]), /operation verb.*oo session-state list --json/);
for (const spelling of [["one", "shot"].join("-"), ["one", "shot"].join("")]) {
  assert.match(usage([spelling, "what"]), /oo -p/, `${spelling} names -p`);
}
assert.equal(usage(["-p", "hi", "--session"]), "--session needs an id or path");
assert.equal(usage(["--session", "--continue"]), "--session needs an id or path", "a flag is not a session value");
assert.equal(usage(["--from-session"]), "--from-session needs an id");
assert.equal(usage(["-p"]), "-p/--prompt needs the prompt text");
assert.equal(usage(["-p", "  "]), "-p/--prompt needs the prompt text");
assert.match(usage(["--continue", "-i"]), /only valid by itself/);

process.stdout.write("ok — oo args: reserved nouns, -p prompt, resume flags, removed spellings name replacements\n");

import assert from "node:assert/strict";
import { preservesSinceScope, sinceWindowStart } from "./tool-use.mjs";

// A fixed clock, so the proof does not depend on the day it runs.
const now = Date.parse("2026-10-08T12:00:00");
const scoped = (value: string) => preservesSinceScope(["--query", "feedback", "--since", value], "7d", now);

assert.equal(sinceWindowStart("7d", now), now - 7 * 86_400_000);
assert.equal(sinceWindowStart("2026-10-01", now), Date.parse("2026-10-01T00:00:00"));
assert.equal(sinceWindowStart("today", now), Date.parse("2026-10-08T00:00:00"));
assert.equal(sinceWindowStart("last week", now), null, "an unsupported spelling selects no window");

// The spelling the case names, and the dates an agent computes for the same window, both pass.
assert.equal(scoped("7d"), true);
assert.equal(scoped("2026-10-01"), true, "the date for the requested window is the requested scope");
assert.equal(scoped("2026-10-02"), true, "within a day of the requested start is the same scope");
assert.equal(preservesSinceScope(["--since=2026-10-01"], "7d", now), true, "--since=value is the same flag");

// A broader window is a different scope: it would answer a seven-day question with older evidence.
assert.equal(scoped("14d"), false);
assert.equal(scoped("30d"), false);
assert.equal(scoped("2026-09-24"), false, "a fortnight reaches past the requested window");
assert.equal(scoped("2026-09-30"), false, "more than a day earlier is a broader window");

// A window that falls short does not preserve the requested scope either.
assert.equal(scoped("1d"), false);
assert.equal(scoped("today"), false);
assert.equal(scoped("2026-10-06"), false);

// No scope at all, or a scope on some other flag, is not a scoped search.
assert.equal(preservesSinceScope(["--query", "feedback"], "7d", now), false);
assert.equal(preservesSinceScope(["--until", "2026-10-01"], "7d", now), false);
assert.equal(preservesSinceScope(["--since"], "7d", now), false, "a flag with no value selects no window");

console.log("ok — a time-scoped search is judged by the window it selects, not the spelling it used");

// Synthetic session fixtures — the eval's CONTROLLED ground truth. Four sessions, two
// transcript formats, three fictional repos, all invented (no real/personal data). This is
// deliberately small and hand-planted so rubrics can be exact; it is NOT a representative
// corpus. A larger open-source corpus is tracked in issue #32 — this stays the controlled
// core. Every case in ../cases.yaml keys off details planted here; change a fact, update its case.
//
// Timestamps are OFFSETS (minutes before "now"): the seed script materializes them
// relative to build time so activity windows behave the same on every run.
//
// Planted ground truth:
//   aurora-weather / flaky-test (claude, needs-you, priority escalated 2→3→4):
//     error literal "AssertionError: expected cache hit within 300s TTL"
//     decision: FakeClock over sleep() — sleeps made CI 4m slower and still flaked on
//     loaded runners; PR #42 open awaiting the owner's review.
//   aurora-weather / units-flag (claude, working):
//     bug literal "KeyError: 'wind_gust_kph'"; fix: normalize units at the API boundary
//     in normalize_observation() instead of per-renderer conversions.
//   lumen-notes / storage-migration (claude, idle ~6 days — the stale one):
//     open decision Dexie vs raw IndexedDB; agent recommended Dexie 4 for the
//     transaction ergonomics; owner never replied.
//   quasar-api / rate-limiter (codex, task_complete):
//     root cause: RateLimiter.refill() read refill_interval_ms as SECONDS, so buckets
//     refilled 1000x too slowly and burst traffic saw spurious 429s.
//   Nothing anywhere discusses GraphQL federation (the negative case).

/** Claude-format line factory: {type, message, cwd, sessionId, timestamp}. */
const claudeMsg = (role, text, offsetMin, stop) => ({
  kind: "claude",
  role,
  text,
  offsetMin,
  stop: stop ?? (role === "assistant" ? "end_turn" : undefined),
});

/** Codex-format entries: session_meta / event_msg lifecycle / response_item messages. */
const codexMsg = (role, text, offsetMin) => ({ kind: "codex", role, text, offsetMin });

export const SESSIONS = [
  {
    id: "fx-aurora-flaky-4b21",
    source: "claude",
    repo: "aurora-weather",
    cwd: "/home/dev/projects/aurora-weather",
    slug: "-home-dev-projects-aurora-weather",
    state: "needs-you",
    stateOffsetMin: 30,
    triageHistory: [
      { offsetMin: 200, priority: 2, topic: "Flaky forecast cache test", summary: "Investigating an intermittently failing cache test.", nextSteps: "Reproduce the flake locally." },
      { offsetMin: 120, priority: 3, topic: "Flaky forecast cache test", summary: "Flake reproduced; CI failed twice more on unrelated PRs.", nextSteps: "Pick a deflaking strategy." },
      { offsetMin: 30, priority: 4, topic: "Flaky forecast cache test", summary: "Fix ready with FakeClock; PR #42 opened.", nextSteps: "Review and merge PR #42." },
    ],
    messages: [
      claudeMsg("user", "our forecast cache test keeps failing intermittently in CI, can you look into test_forecast_cache_expiry?", 240),
      claudeMsg("assistant", "Looking at the failures now. The failing assertion is: AssertionError: expected cache hit within 300s TTL. It fails on roughly one in five CI runs.", 236),
      claudeMsg("user", "why only sometimes?", 230),
      claudeMsg("assistant", "The test sleeps 2 seconds and asserts the entry is still cached, but the TTL check compares wall-clock time. On loaded CI runners the sleep plus test setup occasionally exceeds the 300s TTL boundary window, so the entry is already evicted when the assertion runs.", 226),
      claudeMsg("user", "options?", 180),
      claudeMsg("assistant", "Two options: (1) pad the sleeps with generous margins — simple, but it made the suite about 4 minutes slower when I tried it, and it still flaked once on a heavily loaded runner; (2) inject a FakeClock into ForecastCache so the test controls time explicitly and never sleeps. I recommend the FakeClock: it is deterministic, faster, and removes the wall-clock dependency entirely.", 176),
      claudeMsg("user", "go with the FakeClock", 150),
      claudeMsg("assistant", "Done. ForecastCache now takes a clock parameter defaulting to the system clock; test_forecast_cache_expiry drives a FakeClock and asserts eviction at exactly TTL+1. All 212 tests pass locally in 41s (was 4m52s with the padded-sleep variant). I opened PR #42 with the change.", 40, "end_turn"),
      claudeMsg("user", "anything left before I review?", 32),
      claudeMsg("assistant", "PR #42 is ready for your review — the FakeClock change plus a regression note in the test docstring. CI is green on the PR branch.", 30, "end_turn"),
    ],
  },
  {
    id: "fx-aurora-units-9c77",
    source: "claude",
    repo: "aurora-weather",
    cwd: "/home/dev/projects/aurora-weather",
    slug: "-home-dev-projects-aurora-weather",
    state: "working",
    stateOffsetMin: 5,
    triageHistory: [
      { offsetMin: 90, priority: 3, topic: "Add --units flag", summary: "Adding metric/imperial output units to the CLI.", nextSteps: "Wire the flag through the renderers." },
      { offsetMin: 5, priority: 3, topic: "Add --units flag", summary: "Imperial conversion crashed on gust data; normalizing at the API boundary.", nextSteps: "Agent is mid-refactor of normalize_observation()." },
    ],
    messages: [
      claudeMsg("user", "add a --units flag, metric or imperial, defaulting to metric", 100),
      claudeMsg("assistant", "Plan: parse --units in the CLI entrypoint, thread it to the renderers, convert in each renderer. Starting with the table renderer.", 96),
      claudeMsg("user", "imperial mode crashes on the storm fixture", 20),
      claudeMsg("assistant", "Reproduced: KeyError: 'wind_gust_kph' — the API omits gust data for calm observations, and the per-renderer conversion assumed the key exists. Rather than defending in every renderer, I'm moving all unit handling to the API boundary: normalize_observation() will fill optional fields and convert once, so renderers stay unit-blind. Refactoring now.", 5, "tool_use"),
    ],
  },
  {
    id: "fx-lumen-storage-2e8d",
    source: "claude",
    repo: "lumen-notes",
    cwd: "/home/dev/projects/lumen-notes",
    slug: "-home-dev-projects-lumen-notes",
    state: "idle",
    stateOffsetMin: 6 * 24 * 60,
    triageHistory: [
      { offsetMin: 7 * 24 * 60, priority: 2, topic: "Storage migration to IndexedDB", summary: "Planning the move off localStorage for large notebooks.", nextSteps: "Choose Dexie vs raw IndexedDB." },
      { offsetMin: 6 * 24 * 60, priority: 2, topic: "Storage migration to IndexedDB", summary: "Agent recommended Dexie 4; awaiting the owner's call.", nextSteps: "Owner to decide Dexie 4 vs raw IDB." },
    ],
    messages: [
      claudeMsg("user", "localStorage is choking on big notebooks, we should move to IndexedDB. dexie or raw?", 7 * 24 * 60),
      claudeMsg("assistant", "Comparing them against our access patterns: we need compound indexes on (notebook, updatedAt) and bulk upserts on sync. Raw IndexedDB handles both but the transaction boilerplate is heavy and error-prone. Dexie 4 gives us those compound indexes declaratively, bulkPut for sync, and a liveQuery hook that fits the editor's reactive updates. I recommend Dexie 4 — the transaction ergonomics alone remove most of the migration risk.", 6 * 24 * 60 + 30, "end_turn"),
      claudeMsg("assistant", "Ready to start on the Dexie schema whenever you confirm the direction.", 6 * 24 * 60, "end_turn"),
    ],
  },
  {
    id: "fx-quasar-ratelimit-7f3a",
    source: "codex",
    repo: "quasar-api",
    cwd: "/home/dev/projects/quasar-api",
    state: "idle",
    stateOffsetMin: 26 * 60,
    triageHistory: [
      { offsetMin: 27 * 60, priority: 4, topic: "Spurious 429s from the rate limiter", summary: "Clients report 429s far below their quota.", nextSteps: "Find why buckets exhaust early." },
      { offsetMin: 26 * 60, priority: 1, topic: "Spurious 429s from the rate limiter", summary: "Root cause fixed: refill interval unit bug in RateLimiter.refill().", nextSteps: "Ship it in the next deploy." },
    ],
    messages: [
      codexMsg("user", "clients are getting 429 too many requests way below their quota, dig into the rate limiter", 27 * 60),
      codexMsg("assistant", "Found it. RateLimiter.refill() reads the refill_interval_ms config value but treats it as SECONDS — it multiplies by the elapsed interval count without converting, so buckets refill 1000x too slowly. Any burst drains the bucket and it effectively never refills, hence the spurious 429s.", 26 * 60 + 20),
      codexMsg("user", "fix it and add a regression test", 26 * 60 + 15),
      codexMsg("assistant", "Fixed: refill() now converts refill_interval_ms to milliseconds consistently, and test_refill_rate_units pins a bucket at 10 req/s and asserts recovery after exactly one second of simulated time. Full suite green.", 26 * 60),
    ],
  },
];

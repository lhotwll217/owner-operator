// agentsview (https://github.com/kenn-io/agentsview) as an optional discovery backend for
// `oo search`. Owner Operator only detects a running agentsview daemon and queries its HTTP API;
// it never installs, configures, or starts one. Each hit is mapped back to the transcript file
// and session-grep message index Owner Operator already uses, so the wrapper's privacy policy,
// output budget, rendering, and `--session ID --at IDX` drill-in apply unchanged.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import claude from "./vendor/session-grep/adapters/claude.mjs";
import codex from "./vendor/session-grep/adapters/codex.mjs";
import pi from "./vendor/session-grep/adapters/pi.mjs";

const ADAPTERS = { claude, codex, pi };

/** The running daemon's base URL, or why there is none. `agentsview serve status` reports a
 * running server without starting one. */
export function detectAgentsview() {
  const status = spawnSync("agentsview", ["serve", "status"], { encoding: "utf8", timeout: 5_000 });
  if (status.error?.code === "ENOENT") return { unavailable: "not installed" };
  if (status.error || status.status !== 0) return { unavailable: "status check failed" };
  const url = /agentsview running at (\S+)/.exec(status.stdout)?.[1];
  return url ? { url } : { unavailable: "not running" };
}

/** One page of agentsview content-search hits, newest or best first, and the cursor of the next
 * page (0 when there is none). Throws with agentsview's own error text (for example semantic
 * search not enabled, or an RE2-incompatible regex). */
export async function searchAgentsview(url, { query, mode, limit, agent, includeTools, activeSince, activeUntil, cursor = 0 }) {
  const params = new URLSearchParams({
    pattern: query,
    mode,
    limit: String(limit),
    agent,
    // session-grep searches every transcript file in a store; agentsview hides these by default.
    include_children: "true",
    include_automated: "true",
    include_one_shot: "true",
  });
  // session-grep searches conversation text and readable reasoning by default, tool calls and
  // results only on request. agentsview's semantic, hybrid, and FTS modes index messages only.
  if ((mode === "substring" || mode === "regex") && !includeTools) params.set("in", "messages,thinking");
  if (activeSince) params.set("active_since", activeSince);
  if (activeUntil) params.set("date_to", activeUntil);
  if (cursor) params.set("cursor", String(cursor));
  const response = await fetch(`${url.replace(/\/$/, "")}/api/v1/search/content?${params}`, {
    headers: { "X-AgentsView-Search-Intent": "semantic" },
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? body.detail ?? `HTTP ${response.status}`);
  // A body without a matches list is not agentsview's search answer; reading it as zero hits
  // would report a false absence instead of falling back.
  if (!Array.isArray(body.matches)) throw new Error("unexpected search response");
  return { matches: body.matches ?? [], nextCursor: body.next_cursor ?? 0 };
}

/** The Owner Operator stable session id for an agentsview session id (`codex:<uuid>`,
 * `pi:<uuid>`, or a bare Claude id). */
export function stableIdOf(agentsviewSessionId) {
  return String(agentsviewSessionId).replace(/^(?:codex|pi):/, "");
}

/** Every message in a transcript, numbered exactly as session-grep numbers them
 * (session-grep.mjs `messagesFrom`): one index per JSONL record whose text is non-empty with
 * tool entries included. `text` honors includeTools the way the primitive's search view does,
 * and an injected skill body is reduced to session-grep's placeholder (`reduceSkillBody`) and
 * flagged `skillBody`, since session-grep does not search it without --include-skill-bodies.
 * `toolEntry` marks a record that holds only tool calls or results. `time` dates a record
 * without a timestamp as the primitive's --since/--until do: by the view's first message, then
 * the file's mtime. test/sessions-agentsview-parity.integration.test.ts fails when this copy and
 * the primitive disagree. */
export function transcriptMessages(file, type, { includeTools }) {
  const adapter = ADAPTERS[type];
  const out = [];
  let position = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const full = adapter.message(record, { includeTools: true });
    if (!full || !full.text.trim()) continue;
    const index = position++;
    const bare = adapter.message(record, { includeTools: false });
    const visible = includeTools ? full : bare;
    const skill = visible?.text.trim() ? skillBodyName(visible.text) : null;
    out.push({
      index,
      role: full.role,
      timestamp: full.timestamp,
      text: skill ? `[skill body omitted: ${skill}]` : visible?.text.trim() ? visible.text : null,
      fullText: full.text,
      toolEntry: !bare?.text.trim(),
      ...(skill ? { skillBody: true } : {}),
    });
  }
  const first = out.find((message) => message.text)?.timestamp;
  let mtime;
  for (const message of out) {
    message.time = timeOf(message.timestamp) ?? timeOf(first) ?? (mtime ??= fs.statSync(file).mtimeMs);
  }
  return out;
}

// session-grep.mjs `timeOf`.
function timeOf(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

// session-grep.mjs `reduceSkillBody`: Claude Code opens an injected SKILL.md with its base
// directory; Codex wraps it in <skill><name>.
function skillBodyName(text) {
  const claude = /^\s*Base directory for this skill:\s*(\S+)/.exec(text);
  if (claude) return path.basename(claude[1]);
  return /^\s*<skill>\s*<name>([^<]+)<\/name>/.exec(text)?.[1].trim() ?? null;
}

/** The message an agentsview hit points at: `{ message }`, `{ hidden: true }` when it is a tool
 * entry the requested view leaves out, or null. agentsview and session-grep number messages
 * differently: agentsview merges consecutive Claude assistant records that share a message id
 * into one message stamped with its last record's time, attaches a Codex tool call's output to
 * the call, and files some tool input (Codex custom tool calls) as message text, where
 * session-grep counts each record and treats tool input as a tool entry. So start at the last record at or before the hit's instant (agentsview drops trailing
 * zeros from milliseconds, so compare instants) and walk back through that turn, stopping at the
 * owner's previous message, to the nearest record that `contains` the hit. agentsview also
 * attaches each tool result to its call and stamps a result hit with the call's time, so a
 * result hit not found behind its instant walks forward through the turn's tool entries,
 * stopping at the owner's next message. A hit found nowhere whose instant is a tool call the
 * view hides counts as hidden: a semantic hit's snippet is cut from agentsview's rendering of
 * the merged turn, which writes tool calls as `[Bash: …]` text no record holds, and agentsview
 * labels every semantic hit `location: "message"`. */
export function messageForHit(messages, hit, contains) {
  const time = Date.parse(hit.timestamp);
  let at = -1;
  // agentsview leaves a record without a timestamp unstamped, so only a record's own timestamp
  // can be a hit's instant; its fallback `time` would anchor hits out of order.
  for (let index = 0; index < messages.length; index++) {
    if (Date.parse(messages[index].timestamp) <= time) at = index;
  }
  const found = (message) => message.text ? { message } : { hidden: true };
  const ownerMessage = (message) => message.role === "user" && !message.toolEntry;
  for (let index = at; index >= 0; index--) {
    const message = messages[index];
    if (contains(message.fullText)) return found(message);
    if (index < at && ownerMessage(message)) break;
  }
  if (hit.location === "tool_result") {
    for (let index = at + 1; index < messages.length && !ownerMessage(messages[index]); index++) {
      const message = messages[index];
      if (message.toolEntry && contains(message.fullText)) return found(message);
    }
  }
  return messages[at]?.toolEntry && !messages[at].text ? { hidden: true } : null;
}

/** A test for whether a transcript message contains an agentsview hit: the query for literal and
 * regex modes, otherwise a stretch of agentsview's snippet. Whitespace and case are ignored. A
 * hit whose snippet is empty matches no message. */
export function hitMatcher({ mode, query }) {
  const flat = (text) => String(text).replace(/\s+/g, " ").toLowerCase();
  if (mode === "substring") {
    const needle = flat(query);
    return () => (text) => flat(text).includes(needle);
  }
  if (mode === "regex") {
    let pattern = null;
    try { pattern = new RegExp(query.replace(/^\(\?i\)/, ""), "iu"); } catch { /* RE2-only syntax: use the snippet */ }
    if (pattern) return () => (text) => pattern.test(text);
  }
  return (hit) => {
    // Snippets are windows cut mid-word: drop the partial words at each end.
    const words = flat(String(hit.snippet ?? "").replace(/^\.{3}|\.{3}$/g, "")).trim().split(" ");
    const probe = words.slice(1, -1).join(" ").slice(0, 60).trim() || words.join(" ").slice(0, 60);
    return (text) => !!probe && flat(text).includes(probe);
  };
}

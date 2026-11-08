// agentsview (https://github.com/kenn-io/agentsview) as an optional discovery backend for
// `oo search`. Owner Operator only detects a running agentsview daemon and queries its HTTP API;
// it never installs, configures, or starts one. Each hit is mapped back to the transcript file
// and session-grep message index Owner Operator already uses, so the wrapper's privacy policy,
// output budget, rendering, and `--session ID --at IDX` drill-in apply unchanged.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
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
export async function searchAgentsview(url, { query, mode, limit, agent, includeTools, activeSince, cursor = 0 }) {
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
  if (cursor) params.set("cursor", String(cursor));
  const response = await fetch(`${url.replace(/\/$/, "")}/api/v1/search/content?${params}`, {
    headers: { "X-AgentsView-Search-Intent": "semantic" },
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? body.detail ?? `HTTP ${response.status}`);
  return { matches: body.matches ?? [], nextCursor: body.next_cursor ?? 0 };
}

/** The Owner Operator stable session id for an agentsview session id (`codex:<uuid>`,
 * `pi:<uuid>`, or a bare Claude id). */
export function stableIdOf(agentsviewSessionId) {
  return String(agentsviewSessionId).replace(/^(?:codex|pi):/, "");
}

/** Every message in a transcript, numbered exactly as session-grep numbers them
 * (session-grep.mjs `messagesFrom`): one index per JSONL record whose text is non-empty with
 * tool entries included. `text` honors includeTools the way the primitive's search view does. */
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
    const visible = includeTools ? full : adapter.message(record, { includeTools: false });
    out.push({
      index,
      role: full.role,
      timestamp: full.timestamp,
      time: Date.parse(full.timestamp),
      text: visible?.text.trim() ? visible.text : null,
      fullText: full.text,
    });
  }
  return out;
}

/** The message an agentsview hit points at: `{ message }`, `{ hidden: true }` when it is a tool
 * entry the requested view leaves out, or null. agentsview and session-grep number messages
 * differently: agentsview folds an assistant turn's text, tool calls, and tool results into one
 * message stamped with its last record's time, and files some tool input (Codex custom tool
 * calls) as message text, where session-grep counts each record and treats tool input as a tool
 * entry. So start at the last record at or before the hit's instant (agentsview drops trailing
 * zeros from milliseconds, so compare instants) and walk back through that turn, stopping at the
 * owner's previous message, to the nearest record that `contains` the hit. */
export function messageForHit(messages, hit, contains) {
  const time = Date.parse(hit.timestamp);
  let at = -1;
  for (let index = 0; index < messages.length; index++) {
    if (messages[index].time <= time) at = index;
  }
  for (let index = at; index >= 0; index--) {
    const message = messages[index];
    if (contains(message.fullText)) return message.text ? { message } : { hidden: true };
    if (index < at && message.role === "user" && message.text && !isToolResult(message)) break;
  }
  return null;
}

function isToolResult(message) {
  return message.text === message.fullText && /^\{"(?:tool_use_id|type":"(?:function_call_output|custom_tool_call_output|tool_result))"/.test(message.text);
}

/** A test for whether a transcript message contains an agentsview hit: the query for literal and
 * regex modes, otherwise a stretch of agentsview's snippet. Whitespace and case are ignored. */
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
    return (text) => !probe || flat(text).includes(probe);
  };
}

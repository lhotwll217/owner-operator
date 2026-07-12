import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { resolveBackend } from "../../gateway/client";
import { getCurrentSessionStateRows, type CurrentSessionStateRow } from "../../gateway/session-state";

const MarkThreadDoneParams = Type.Object({
  ids: Type.Optional(Type.Array(Type.String({ description: "Stable thread ids to mark done." }))),
  indexes: Type.Optional(Type.Array(Type.Integer({
    minimum: 1,
    description: "Current visible row numbers.",
  }))),
  queries: Type.Optional(Type.Array(Type.String({
    description: "User-provided names, repos, or topic snippets to resolve against the current session state.",
  }))),
});

const unique = <T,>(values: readonly T[]): T[] => [...new Set(values)];
const cleanIds = (ids: readonly string[] | undefined): string[] =>
  unique((ids ?? []).map((value) => value.trim()).filter(Boolean));

const CurrentSessionStateParams = Type.Object({
  state: Type.Optional(Type.Union([
    Type.Literal("needs-you"),
    Type.Literal("working"),
    Type.Literal("idle"),
    Type.Literal("done"),
  ], {
    description:
      "Optional exact state filter. Use needs-you for questions about what is waiting on or needs the owner.",
  })),
  ids: Type.Optional(Type.Array(Type.String({
    description: "Stable session id to resolve against the current widget rows.",
  }), {
    maxItems: 50,
    description: "Optional exact stable-id filter. Use this when the caller already supplied session ids.",
  })),
});

export interface CurrentSessionStateFilters {
  state?: CurrentSessionStateRow["state"];
  ids?: readonly string[];
}

export function filterCurrentSessionStateRows(
  rows: readonly CurrentSessionStateRow[],
  filters: CurrentSessionStateFilters,
): CurrentSessionStateRow[] {
  const ids = new Set(cleanIds(filters.ids));
  return rows.filter((thread) =>
    (!filters.state || thread.state === filters.state) &&
    (!ids.size || ids.has(thread.id))
  );
}

export function currentSessionStateResult(
  rows: readonly CurrentSessionStateRow[],
  filters: CurrentSessionStateFilters,
  readAt = new Date().toISOString(),
) {
  const ids = cleanIds(filters.ids);
  const threads = filterCurrentSessionStateRows(rows, { ...filters, ids });
  const found = new Set(threads.map((thread) => thread.id));
  const visible = new Set(rows.map((thread) => thread.id));
  return {
    scope: "current-widget-projection",
    authoritative: true,
    readAt,
    filters: {
      ...(filters.state ? { state: filters.state } : {}),
      ...(ids.length ? { ids } : {}),
    },
    totalRows: rows.length,
    matchedRows: threads.length,
    evidenceBoundary: {
      kind: "summary-index",
      transcriptEvidence: false,
      next: "Use each thread id with session-search when the question asks what changed, why, proof, exact artifacts, or other transcript details.",
    },
    ...(ids.length ? {
      missingIds: ids.filter((id) => !visible.has(id)),
      stateFilteredIds: ids.filter((id) => visible.has(id) && !found.has(id)),
    } : {}),
    threads,
  };
}

const cleanIndexes = (indexes: readonly number[] | undefined): number[] =>
  unique((indexes ?? []).filter((value) => Number.isInteger(value) && value > 0));
const cleanQueries = (queries: readonly string[] | undefined): string[] =>
  unique((queries ?? []).map((value) => value.trim()).filter(Boolean));
const haystack = (thread: CurrentSessionStateRow): string =>
  [thread.id, thread.repo, thread.app, thread.topic, thread.summary, thread.nextSteps]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

export const getCurrentSessionStateTool = defineTool({
  name: "get_current_session_state",
  label: "Get current session state",
  description:
    "Read the owner's current session state — the exact rows their widget shows: row " +
    "number, id, repo, topic, state, priority, next step. State is authoritative: for " +
    "'what needs me?' use state=needs-you; priority or next-step wording does not override state. " +
    "Rows are summary indexes, not transcript evidence; use their ids with session-search for " +
    "exact changes, reasons, proof, or artifact details. When stable ids are already known, pass " +
    "ids to return only those widget rows.",
  parameters: CurrentSessionStateParams,
  async execute(_id, params) {
    const rows = await getCurrentSessionStateRows();
    const result = currentSessionStateResult(rows, params);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      details: result,
    };
  },
});

export const markThreadDoneTool = defineTool({
  name: "mark_thread_done",
  label: "Mark thread done",
  description:
    "Mark one or more threads in the current session state done, by stable id, visible row number, or name/topic query.",
  parameters: MarkThreadDoneParams,
  async execute(_id, params) {
    const directIds = cleanIds(params.ids);
    const indexes = cleanIndexes(params.indexes);
    const queries = cleanQueries(params.queries);
    const rows = indexes.length || queries.length ? await getCurrentSessionStateRows() : [];
    const byIndex = new Map(rows.map((thread) => [thread.index, thread]));
    const indexTargets = indexes
      .map((index) => byIndex.get(index))
      .filter((thread): thread is CurrentSessionStateRow => !!thread);
    const queryResults = queries.map((query) => {
      const matches = rows.filter((thread) => haystack(thread).includes(query.toLowerCase()));
      return { query, matches };
    });
    const queryTargets = queryResults
      .filter((result) => result.matches.length === 1)
      .map((result) => result.matches[0]);
    const ids = unique([...directIds, ...indexTargets.map((thread) => thread.id), ...queryTargets.map((thread) => thread.id)]);
    const missingIndexes = indexes.filter((index) => !byIndex.has(index));
    const unresolvedQueries = queryResults
      .filter((result) => result.matches.length !== 1)
      .map((result) => ({
        query: result.query,
        matches: result.matches.map((thread) => ({
          index: thread.index,
          id: thread.id,
          repo: thread.repo,
          topic: thread.topic,
        })),
      }));

    const result = await (await resolveBackend()).markDone(ids);
    const marked = result.marked.map((thread) => rows.find((row) => row.id === thread.id) ?? {
      index: null,
      id: thread.id,
      topic: thread.topic,
      repo: thread.repo,
    });
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          marked,
          alreadyDoneIds: result.alreadyDoneIds,
          missingIds: result.missingIds,
          missingIndexes,
          unresolvedQueries,
        }, null, 2),
      }],
      details: {
        marked,
        alreadyDoneIds: result.alreadyDoneIds,
        missingIds: result.missingIds,
        missingIndexes,
        unresolvedQueries,
      },
    };
  },
});

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
    "number, id, repo, topic, state, priority, next step.",
  parameters: Type.Object({}),
  async execute() {
    const threads = await getCurrentSessionStateRows();
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ threads }, null, 2) }],
      details: { threads },
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

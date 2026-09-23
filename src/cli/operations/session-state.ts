import type { MarkThreadsDoneResult, SessionStateRow } from "@owner-operator/core";
import { emit, gateway, type Noun } from "./operation";

const rowLine = (row: SessionStateRow, index: number): string =>
  `${String(index + 1).padStart(3)}. ${row.state.padEnd(9)} ${row.app} · ${row.repo} · ${row.topic}  ${row.id}`;

export const sessionState: Noun = {
  summary: "the owner's current session rows, as the widget shows them",
  verbs: {
    list: {
      summary: "current session-state rows (GET /session-state)",
      async run({ json }) {
        const rows = await (await gateway()).sessionState();
        emit(json, rows, () => rows.length ? rows.map(rowLine).join("\n") : "no sessions");
        return 0;
      },
    },
    done: {
      args: "<id...>",
      summary: "mark sessions done by exact id (POST /done); ids come from `list`",
      minPositionals: 1,
      variadic: true,
      async run({ positionals, json }) {
        const result: MarkThreadsDoneResult = await (await gateway()).markDone(positionals);
        emit(json, result, () => [
          ...result.marked.map((row) => `done     ${row.id}`),
          ...result.alreadyDoneIds.map((id) => `already  ${id}`),
          ...result.missingIds.map((id) => `missing  ${id}`),
        ].join("\n"));
        return result.missingIds.length ? 1 : 0;
      },
    },
  },
};

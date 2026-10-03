import type { MarkThreadsDoneResult, SessionStateRow, ThreadState } from "@owner-operator/core";
import { emit, gateway, UsageError, type Noun } from "./operation";

const STATES: readonly ThreadState[] = ["needs-you", "working", "idle", "done"];

// Row numbers are widget positions, so a filtered list keeps the numbers the owner sees.
const rowLine = (row: SessionStateRow, position: number): string =>
  `${String(position).padStart(3)}. ${row.state.padEnd(9)} ${row.app} · ${row.repo} · ${row.topic}  ${row.id}`;

export const sessionState: Noun = {
  summary: "the owner's current session rows, as the widget shows them",
  useWhen: "what is active right now, what needs the owner, or marking finished sessions done",
  verbs: {
    list: {
      summary: "current rows (GET /session-state); state is authoritative, even when empty. Rows "
        + "index sessions: take an id to `oo search` for what changed, why, or proof",
      options: {
        state: { type: "string", help: `only rows in this exact state: ${STATES.join(", ")}` },
      },
      examples: [
        "oo session-state list",
        "oo session-state list --state needs-you",
        "oo session-state list --json",
      ],
      async run({ values, json }) {
        const state = values.state as string | undefined;
        if (state !== undefined && !STATES.includes(state as ThreadState)) {
          throw new UsageError(`--state must be one of ${STATES.join(", ")}`);
        }
        const rows = (await (await gateway()).sessionState())
          .map((row, index) => ({ row, position: index + 1 }))
          .filter(({ row }) => !state || row.state === state);
        await emit(json, rows.map(({ row }) => row), () => rows.length
          ? rows.map(({ row, position }) => rowLine(row, position)).join("\n")
          : state ? `no sessions in state ${state}` : "no sessions");
        return 0;
      },
    },
    done: {
      args: "<id...>",
      summary: "mark sessions done by exact id (POST /done); ids come from `list`",
      minPositionals: 1,
      variadic: true,
      examples: ["oo session-state done <id>", "oo session-state done <id> <id> --json"],
      async run({ positionals, json }) {
        const result: MarkThreadsDoneResult = await (await gateway()).markDone(positionals);
        await emit(json, result, () => [
          ...result.marked.map((row) => `done     ${row.id}`),
          ...result.alreadyDoneIds.map((id) => `already  ${id}`),
          ...result.missingIds.map((id) => `missing  ${id}`),
        ].join("\n"));
        return result.missingIds.length ? 1 : 0;
      },
    },
  },
};

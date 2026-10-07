import { DatabaseQueryAction } from "@owner-operator/core";
import type { ColumnInfo, QueryResult, TableInfo } from "../../state/query";
import { emit, gateway, type Noun } from "./operation";

export const db: Noun = {
  summary: "read-only SQL over the state database (POST /query-database)",
  useWhen: "structured facts and history: past session versions, schedule runs, delegated runs, anything SQL answers",
  guide: "Run `oo db tables`, then `oo db describe <table>`, before unfamiliar SQL: the table and\n"
    + "column docs say what each holds.",
  verbs: {
    tables: {
      summary: "table names, row counts, and documented purpose",
      examples: ["oo db tables", "oo db tables --json"],
      async run({ json }) {
        const tables = await (await gateway()).queryDatabase({ action: DatabaseQueryAction.ListTables }) as TableInfo[];
        await emit(json, tables, () => tables.map((table) => `${table.name.padEnd(28)} ${String(table.rows).padStart(7)}  ${table.description}`).join("\n"));
        return 0;
      },
    },
    describe: {
      args: "<table>",
      summary: "the table's documented purpose and columns",
      minPositionals: 1,
      examples: ["oo db describe thread_details", "oo db describe agent_runs --json"],
      async run({ positionals: [table], json }) {
        const described = await (await gateway()).queryDatabase({ action: DatabaseQueryAction.DescribeTable, table: table! }) as {
          description: string;
          columns: ColumnInfo[];
        };
        await emit(json, described, () => [
          `${table} — ${described.description}`,
          "",
          ...described.columns.map((column) =>
            `  ${column.name.padEnd(28)} ${`${column.type}${column.primaryKey ? " pk" : ""}${column.notNull ? " not null" : ""}`.padEnd(22)} ${column.description}`),
        ].join("\n"));
        return 0;
      },
    },
    query: {
      args: "<sql>",
      summary: "run one read-only SELECT; results are capped and flag truncation",
      guide: "To find which session handled something, match its words against `thread_details.topic`\n"
        + "and `status_summary` before searching transcripts.",
      minPositionals: 1,
      examples: [
        'oo db query "SELECT id, repo, app, last_message_at FROM threads ORDER BY last_message_at DESC LIMIT 10"',
        "oo db query \"SELECT version, written_by, created_at FROM thread_details WHERE thread_id = '<id>' ORDER BY version\" --json",
      ],
      async run({ positionals: [sql], json }) {
        const result = await (await gateway()).queryDatabase({ action: DatabaseQueryAction.Query, sql: sql! }) as QueryResult;
        await emit(json, result, () => [
          ...result.rows.map((row) => JSON.stringify(row)),
          `(${result.rows.length} row${result.rows.length === 1 ? "" : "s"}${result.truncated ? ", truncated: narrow the query" : ""})`,
        ].join("\n"));
        return 0;
      },
    },
  },
};

import { DatabaseQueryAction } from "@owner-operator/core";
import type { ColumnInfo, QueryResult, TableInfo } from "../../state/query";
import { emit, gateway, type Noun } from "./operation";

export const db: Noun = {
  summary: "read-only SQL over the state database (POST /query-database)",
  verbs: {
    tables: {
      summary: "table names, row counts, and documented purpose",
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
      minPositionals: 1,
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

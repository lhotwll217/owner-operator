import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { DatabaseQueryAction } from "@owner-operator/core";
import { resolveBackend } from "../../gateway/client";

export const queryDatabaseTool = defineTool({
  name: "query_database",
  label: "Query session database",
  description:
    "Run read-only SQL over the session state database (SQLite). Actions: list_tables " +
    "(table names + row counts), describe_table (columns + CREATE statement), query " +
    "(execute a SELECT; results capped at 200 rows). The connection is read-only; write statements fail.",
  parameters: Type.Object({
    action: Type.Union([
      Type.Literal("list_tables"),
      Type.Literal("describe_table"),
      Type.Literal("query"),
    ], { description: "list_tables | describe_table | query." }),
    table: Type.Optional(Type.String({ description: "Table name, for describe_table." })),
    sql: Type.Optional(Type.String({ description: "SELECT statement, for query." })),
  }),
  async execute(_id, params) {
    const asText = (value: unknown) => ({
      content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
      details: undefined,
    });
    const gateway = await resolveBackend();
    if (params.action === "list_tables") {
      return asText(await gateway.queryDatabase({ action: DatabaseQueryAction.ListTables }));
    }
    if (params.action === "describe_table") {
      if (!params.table) throw new Error("describe_table needs a table name");
      return asText(await gateway.queryDatabase({ action: DatabaseQueryAction.DescribeTable, table: params.table }));
    }
    if (!params.sql) throw new Error("query needs a sql SELECT statement");
    return asText(await gateway.queryDatabase({ action: DatabaseQueryAction.Query, sql: params.sql }));
  },
});

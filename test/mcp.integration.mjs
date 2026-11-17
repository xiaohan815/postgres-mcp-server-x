import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const url = process.env.TEST_POSTGRES_URL;
if (!url) throw new Error("TEST_POSTGRES_URL is required");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("../dist/index.js", import.meta.url).pathname, url],
  env: { ...process.env, POSTGRES_MCP_SCHEMA: "mcp_x_test" },
});
const client = new Client({ name: "postgres-mcp-server-x-integration", version: "1.0.0" });

function parsed(result) {
  assert.equal(result.isError, false, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
}

try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    ["query", "execute_sql", "execute_batch", "comment_columns"],
  );

  parsed(await client.callTool({ name: "execute_sql", arguments: { sql: "DROP SCHEMA IF EXISTS mcp_x_test CASCADE" } }));
  parsed(await client.callTool({ name: "execute_sql", arguments: { sql: "CREATE SCHEMA mcp_x_test" } }));
  parsed(await client.callTool({ name: "execute_sql", arguments: { sql: "CREATE TABLE mcp_x_test.demo (id bigint, name text)" } }));
  assert.equal(parsed(await client.callTool({
    name: "comment_columns",
    arguments: { schema: "mcp_x_test", comments: [{ table: "demo", column: "name", comment: "中文 O'Reilly \\ 路径" }] },
  })).updated, 1);

  const comment = parsed(await client.callTool({
    name: "query",
    arguments: { sql: "SELECT col_description('mcp_x_test.demo'::regclass, 2) AS value" },
  }));
  assert.equal(comment.rows[0].value, "中文 O'Reilly \\ 路径");

  const failed = await client.callTool({
    name: "execute_batch",
    arguments: { statements: [
      "INSERT INTO mcp_x_test.demo VALUES (1, 'first')",
      "INSERT INTO mcp_x_test.missing VALUES (2)",
    ] },
  });
  assert.equal(failed.isError, true);
  const count = parsed(await client.callTool({ name: "query", arguments: { sql: "SELECT count(*)::int AS value FROM mcp_x_test.demo" } }));
  assert.equal(count.rows[0].value, 0, "failed MCP batch must roll back earlier statements");

  parsed(await client.callTool({ name: "execute_sql", arguments: { sql: "INSERT INTO mcp_x_test.demo VALUES (9223372036854775807, 'ok')" } }));
  const bigint = parsed(await client.callTool({ name: "query", arguments: { sql: "SELECT id FROM mcp_x_test.demo" } }));
  assert.equal(bigint.rows[0].id, "9223372036854775807");

  const multi = await client.callTool({ name: "execute_sql", arguments: { sql: "SELECT 1; DROP TABLE mcp_x_test.demo" } });
  assert.equal(multi.isError, true);
  assert.match(multi.content[0].text, /Only one SQL statement/);

  parsed(await client.callTool({ name: "execute_sql", arguments: { sql: "DROP SCHEMA mcp_x_test CASCADE" } }));
  console.log("MCP protocol integration tests passed");
} finally {
  await client.close();
}

#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import pg from "pg";
import { buildColumnCommentSql, normalizeSingleStatement } from "./sql.js";

const args = process.argv.slice(2);
const databaseUrl = args[0] ?? process.env.POSTGRES_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Provide a PostgreSQL URL as the first argument or POSTGRES_URL/DATABASE_URL");
  process.exit(1);
}

const defaultSchema = process.env.POSTGRES_MCP_SCHEMA || "public";
const writeEnabled = !["0", "false", "no", "off"].includes(
  (process.env.POSTGRES_MCP_WRITE_ENABLED ?? "true").toLowerCase(),
);
const maxBatchSize = Number.parseInt(process.env.POSTGRES_MCP_MAX_BATCH_SIZE ?? "10000", 10);
if (!Number.isSafeInteger(maxBatchSize) || maxBatchSize < 1) {
  throw new Error("POSTGRES_MCP_MAX_BATCH_SIZE must be a positive integer");
}

const pool = new pg.Pool({ connectionString: databaseUrl });
const resourceBaseUrl = new URL(databaseUrl);
resourceBaseUrl.protocol = "postgres:";
resourceBaseUrl.username = "";
resourceBaseUrl.password = "";
resourceBaseUrl.search = "";
resourceBaseUrl.hash = "";

const server = new Server(
  { name: "postgres-mcp-server-x", version: "1.0.0" },
  { capabilities: { resources: {}, tools: {} } },
);

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") return item.toString();
    if (Buffer.isBuffer(item)) return { type: "Buffer", base64: item.toString("base64") };
    return item;
  }, 2);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function textResult(value: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : serialize(value) }], isError };
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

async function inTransaction<T>(readOnly: boolean, action: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let active = false;
  try {
    await client.query(readOnly ? "BEGIN TRANSACTION READ ONLY" : "BEGIN");
    active = true;
    const result = await action(client);
    if (readOnly) await client.query("ROLLBACK");
    else await client.query("COMMIT");
    active = false;
    return result;
  } catch (error) {
    if (active) {
      try { await client.query("ROLLBACK"); } catch (rollbackError) {
        console.error("PostgreSQL rollback failed:", errorText(rollbackError));
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

function summarizeResult(result: pg.QueryResult): Record<string, unknown> {
  return {
    command: result.command,
    rowCount: result.rowCount,
    rows: result.rows,
  };
}

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const result = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
    [defaultSchema],
  );
  return {
    resources: result.rows.map((row) => ({
      uri: new URL(`${encodeURIComponent(defaultSchema)}/${encodeURIComponent(row.table_name)}/schema`, resourceBaseUrl).href,
      mimeType: "application/json",
      name: `\"${defaultSchema}\".\"${row.table_name}\" database schema`,
    })),
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const resourceUrl = new URL(request.params.uri);
  const path = resourceUrl.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (path.length < 3 || path.at(-1) !== "schema") throw new Error("Invalid resource URI");
  const tableName = path.at(-2)!;
  const schemaName = path.at(-3)!;
  const result = await pool.query(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position`,
    [schemaName, tableName],
  );
  return {
    contents: [{ uri: request.params.uri, mimeType: "application/json", text: serialize(result.rows) }],
  };
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "query",
      description: "Run one SQL statement in a read-only transaction",
      inputSchema: {
        type: "object",
        properties: { sql: { type: "string", description: "One SQL statement" } },
        required: ["sql"], additionalProperties: false,
      },
    },
    ...(writeEnabled ? [
      {
        name: "execute_sql",
        description: "Execute one SQL statement in a write transaction and commit it",
        inputSchema: {
          type: "object",
          properties: { sql: { type: "string", description: "One SQL statement; transaction-control statements are rejected" } },
          required: ["sql"], additionalProperties: false,
        },
      },
      {
        name: "execute_batch",
        description: "Execute SQL statements atomically in order; any failure rolls back the whole batch",
        inputSchema: {
          type: "object",
          properties: {
            statements: { type: "array", items: { type: "string" }, minItems: 1, maxItems: maxBatchSize },
          },
          required: ["statements"], additionalProperties: false,
        },
      },
      {
        name: "comment_columns",
        description: "Set or clear PostgreSQL column comments atomically with safely quoted identifiers and text",
        inputSchema: {
          type: "object",
          properties: {
            schema: { type: "string", default: defaultSchema },
            comments: {
              type: "array", minItems: 1, maxItems: maxBatchSize,
              items: {
                type: "object",
                properties: {
                  table: { type: "string" }, column: { type: "string" },
                  comment: { type: ["string", "null"], description: "Use null to remove a comment" },
                },
                required: ["table", "column", "comment"], additionalProperties: false,
              },
            },
          },
          required: ["comments"], additionalProperties: false,
        },
      },
    ] : []),
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const input = requireObject(request.params.arguments ?? {});
    if (request.params.name === "query") {
      const sql = normalizeSingleStatement(requireString(input.sql, "sql"));
      const result = await inTransaction(true, (client) => client.query(sql));
      return textResult(summarizeResult(result));
    }
    if (!writeEnabled) throw new Error("Write tools are disabled by POSTGRES_MCP_WRITE_ENABLED");

    if (request.params.name === "execute_sql") {
      const sql = normalizeSingleStatement(requireString(input.sql, "sql"));
      const result = await inTransaction(false, (client) => client.query(sql));
      return textResult(summarizeResult(result));
    }
    if (request.params.name === "execute_batch") {
      if (!Array.isArray(input.statements) || input.statements.length < 1 || input.statements.length > maxBatchSize) {
        throw new Error(`statements must contain 1 to ${maxBatchSize} SQL statements`);
      }
      const statements = input.statements.map((sql, index) => normalizeSingleStatement(requireString(sql, `statements[${index}]`)));
      const results = await inTransaction(false, async (client) => {
        const summaries = [];
        for (const sql of statements) summaries.push(summarizeResult(await client.query(sql)));
        return summaries;
      });
      return textResult({ statementCount: statements.length, results });
    }
    if (request.params.name === "comment_columns") {
      const schema = input.schema === undefined ? defaultSchema : requireString(input.schema, "schema");
      if (!Array.isArray(input.comments) || input.comments.length < 1 || input.comments.length > maxBatchSize) {
        throw new Error(`comments must contain 1 to ${maxBatchSize} items`);
      }
      const comments = input.comments.map((item, index) => {
        const entry = requireObject(item);
        const comment = entry.comment;
        if (comment !== null && typeof comment !== "string") throw new Error(`comments[${index}].comment must be a string or null`);
        return {
          table: requireString(entry.table, `comments[${index}].table`),
          column: requireString(entry.column, `comments[${index}].column`),
          comment,
        };
      });
      await inTransaction(false, async (client) => {
        for (const item of comments) {
          await client.query(buildColumnCommentSql(schema, item.table, item.column, item.comment));
        }
      });
      return textResult({ schema, updated: comments.length });
    }
    throw new Error(`Unknown tool: ${request.params.name}`);
  } catch (error) {
    return textResult({ error: errorText(error) }, true);
  }
});

async function shutdown(signal: string) {
  console.error(`Received ${signal}; closing PostgreSQL pool`);
  await pool.end();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

const transport = new StdioServerTransport();
await server.connect(transport);

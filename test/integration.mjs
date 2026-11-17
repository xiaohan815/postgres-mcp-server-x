import assert from "node:assert/strict";
import pg from "pg";
import { buildColumnCommentSql, normalizeSingleStatement } from "../dist/sql.js";

const url = process.env.TEST_POSTGRES_URL;
if (!url) throw new Error("TEST_POSTGRES_URL is required");
const pool = new pg.Pool({ connectionString: url });

async function transaction(statements, commit = true) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const statement of statements) await client.query(normalizeSingleStatement(statement));
    await client.query(commit ? "COMMIT" : "ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

try {
  await transaction(["DROP SCHEMA IF EXISTS mcp_x_test CASCADE", "CREATE SCHEMA mcp_x_test", "CREATE TABLE mcp_x_test.demo (id bigint, name text)"]);
  await transaction([buildColumnCommentSql("mcp_x_test", "demo", "name", "中文 O'Reilly \\ 路径")]);
  const comment = await pool.query(`SELECT col_description('mcp_x_test.demo'::regclass, 2) AS value`);
  assert.equal(comment.rows[0].value, "中文 O'Reilly \\ 路径");

  await assert.rejects(
    transaction(["INSERT INTO mcp_x_test.demo VALUES (1, 'first')", "INSERT INTO mcp_x_test.missing VALUES (2)"]),
  );
  const count = await pool.query("SELECT count(*)::int AS value FROM mcp_x_test.demo");
  assert.equal(count.rows[0].value, 0, "failed batch must roll back earlier statements");

  await transaction(["INSERT INTO mcp_x_test.demo VALUES (9223372036854775807, 'ok')"]);
  const bigint = await pool.query("SELECT id FROM mcp_x_test.demo");
  assert.equal(bigint.rows[0].id, "9223372036854775807");
  console.log("integration tests passed");
} finally {
  await pool.query("DROP SCHEMA IF EXISTS mcp_x_test CASCADE");
  await pool.end();
}

import test from "node:test";
import assert from "node:assert/strict";
import { buildColumnCommentSql, normalizeSingleStatement, quoteIdentifier, quoteLiteral } from "../dist/sql.js";

test("accepts one statement with a trailing semicolon", () => {
  assert.equal(normalizeSingleStatement(" UPDATE demo SET value = 1; "), "UPDATE demo SET value = 1");
});

test("does not split semicolons inside strings, comments, identifiers, or dollar quotes", () => {
  const sql = `SELECT ';', \"a;b\", $$x;y$$ /* ; */ -- ;\nFROM demo;`;
  assert.equal(normalizeSingleStatement(sql), sql.slice(0, -1));
});

test("understands PostgreSQL escape strings", () => {
  const sql = String.raw`COMMENT ON COLUMN "s"."t"."c" IS E'O\'Reilly; C:\\tmp'`;
  assert.equal(normalizeSingleStatement(sql), sql);
});

test("rejects multiple and transaction-control statements", () => {
  assert.throws(() => normalizeSingleStatement("SELECT 1; SELECT 2"), /Only one/);
  assert.throws(() => normalizeSingleStatement("COMMIT"), /Transaction-control/);
  assert.throws(() => normalizeSingleStatement("/* controlled */ ROLLBACK"), /Transaction-control/);
});

test("quotes PostgreSQL identifiers and text without losing Unicode", () => {
  assert.equal(quoteIdentifier('a"b'), '"a""b"');
  assert.equal(quoteLiteral("中文 O'Reilly \\ path"), "E'中文 O\\'Reilly \\\\ path'");
});

test("builds safe COMMENT ON COLUMN SQL and supports clearing comments", () => {
  assert.equal(
    buildColumnCommentSql("ai_agent", "demo", "name", "名称"),
    `COMMENT ON COLUMN "ai_agent"."demo"."name" IS E'名称'`,
  );
  assert.equal(
    buildColumnCommentSql("ai_agent", "demo", "name", null),
    `COMMENT ON COLUMN "ai_agent"."demo"."name" IS NULL`,
  );
});

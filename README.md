# PostgreSQL MCP Server X

`@modelcontextprotocol/server-postgres` 的扩展维护版。上游 `0.6.2` 只在只读事务中提供 `query`；本项目保留只读能力，并增加显式写入、原子批处理和字段注释工具。

上游已归档且不再维护。本项目基于其 MIT 许可源码独立发布，来源与固定提交见 [NOTICE](NOTICE)。

## 功能

- `query`：在只读事务中执行一条 SQL，结束后回滚。
- `execute_sql`：在读写事务中执行一条 SQL，成功提交、失败回滚。
- `execute_batch`：按顺序原子执行多条 SQL，任一失败则整批回滚。
- `comment_columns`：安全引用 schema、表名、字段名和中文注释，批量设置或清空字段注释。
- 可配置资源发现 schema，返回可空性和默认值。
- `BIGINT` 无损序列化为字符串，二进制结果序列化为 Base64。
- 拒绝多语句注入和客户端事务控制语句，事务统一由服务端管理。

## 使用

```bash
npx -y postgres-mcp-server-x "postgresql://user:password@host:5432/database"
```

Codex 配置示例：

```toml
[mcp_servers.postgres_x]
command = "npx"
args = ["-y", "postgres-mcp-server-x@1.0.0", "postgresql://user:password@host:5432/database"]

[mcp_servers.postgres_x.env]
POSTGRES_MCP_SCHEMA = "ai_agent"
POSTGRES_MCP_WRITE_ENABLED = "true"
```

也可用 `POSTGRES_URL` 或 `DATABASE_URL` 传入连接串，避免将连接串写在参数中。

## 写入控制

本包是可写扩展版，写工具默认启用。若某个连接只用于查询，可关闭写工具：

```env
POSTGRES_MCP_WRITE_ENABLED=false
```

单批默认最多 10,000 项，可通过 `POSTGRES_MCP_MAX_BATCH_SIZE` 调整。数据库账号自身的权限仍然生效；MCP 不会绕过 PostgreSQL 权限。

## 字段注释示例

调用 `comment_columns`：

```json
{
  "schema": "ai_agent",
  "comments": [
    { "table": "sys_user", "column": "username", "comment": "用户名" },
    { "table": "sys_user", "column": "old_field", "comment": null }
  ]
}
```

整批在同一个事务内执行。字段不存在、权限不足或任意一条失败时，全部回滚。

## 开发与验证

```bash
npm ci
npm test
```

真实 PostgreSQL 集成测试：

```bash
TEST_POSTGRES_URL="postgresql://postgres:postgres@127.0.0.1:5432/postgres" npm run test:integration
```

集成测试会创建临时 schema，验证中文与引号注释、批处理失败回滚和最大 `BIGINT` 精度，结束后删除该 schema。

## License

MIT

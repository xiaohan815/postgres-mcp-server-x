const TRANSACTION_CONTROL = /^(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE\s+SAVEPOINT|PREPARE\s+TRANSACTION)\b/i;

export function normalizeSingleStatement(sql: string): string {
  const trimmed = sql.trim();
  if (!trimmed) {
    throw new Error("SQL must not be empty");
  }

  let state: "normal" | "single" | "double" | "line-comment" | "block-comment" | "dollar" = "normal";
  let blockDepth = 0;
  let dollarTag = "";
  let lastSemicolon = -1;
  let singleBackslashEscapes = false;

  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    const next = trimmed[i + 1];

    if (state === "line-comment") {
      if (char === "\n" || char === "\r") state = "normal";
      continue;
    }
    if (state === "block-comment") {
      if (char === "/" && next === "*") {
        blockDepth += 1;
        i += 1;
      } else if (char === "*" && next === "/") {
        blockDepth -= 1;
        i += 1;
        if (blockDepth === 0) state = "normal";
      }
      continue;
    }
    if (state === "single") {
      if (singleBackslashEscapes && char === "\\" && next !== undefined) i += 1;
      else if (char === "'" && next === "'") i += 1;
      else if (char === "'") state = "normal";
      continue;
    }
    if (state === "double") {
      if (char === '"' && next === '"') i += 1;
      else if (char === '"') state = "normal";
      continue;
    }
    if (state === "dollar") {
      if (trimmed.startsWith(dollarTag, i)) {
        i += dollarTag.length - 1;
        state = "normal";
      }
      continue;
    }

    if (char === "-" && next === "-") {
      state = "line-comment";
      i += 1;
    } else if (char === "/" && next === "*") {
      state = "block-comment";
      blockDepth = 1;
      i += 1;
    } else if (char === "'") {
      const prefix = trimmed[i - 1];
      const beforePrefix = trimmed[i - 2];
      singleBackslashEscapes = (prefix === "E" || prefix === "e")
        && (beforePrefix === undefined || !/[A-Za-z0-9_$]/.test(beforePrefix));
      state = "single";
    } else if (char === '"') {
      state = "double";
    } else if (char === "$") {
      const match = trimmed.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        dollarTag = match[0];
        state = "dollar";
        i += dollarTag.length - 1;
      }
    } else if (char === ";") {
      if (lastSemicolon !== -1) {
        throw new Error("Only one SQL statement is allowed per item");
      }
      lastSemicolon = i;
    }
  }

  if (state === "single" || state === "double" || state === "block-comment" || state === "dollar") {
    throw new Error("SQL contains an unterminated quote or comment");
  }

  if (lastSemicolon !== -1 && trimmed.slice(lastSemicolon + 1).trim() !== "") {
    throw new Error("Only one SQL statement is allowed per item");
  }

  const statement = lastSemicolon === trimmed.length - 1
    ? trimmed.slice(0, -1).trim()
    : trimmed;

  if (TRANSACTION_CONTROL.test(statement.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, ""))) {
    throw new Error("Transaction-control statements are not allowed; the MCP server manages the transaction");
  }
  return statement;
}

export function quoteIdentifier(value: string): string {
  if (!value || value.includes("\0")) {
    throw new Error("PostgreSQL identifier must not be empty or contain NUL");
  }
  return `"${value.replaceAll('"', '""')}"`;
}

export function quoteLiteral(value: string): string {
  if (value.includes("\0")) {
    throw new Error("PostgreSQL text must not contain NUL");
  }
  return `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

export function buildColumnCommentSql(
  schema: string,
  table: string,
  column: string,
  comment: string | null,
): string {
  const target = [schema, table, column].map(quoteIdentifier).join(".");
  return `COMMENT ON COLUMN ${target} IS ${comment === null ? "NULL" : quoteLiteral(comment)}`;
}

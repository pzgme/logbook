import type { Env, ListOptions, ListResult, LogEntry, LogInput, LogLevel } from "../types";

/**
 * 日志数据访问层。
 * 所有 SQL 一律使用 prepare + bind，禁止字符串拼接。
 */

const MAX_LIMIT = 100;
const MAX_TITLE_LENGTH = 200;
const MAX_CONTENT_LENGTH = 20000;
const MAX_CATEGORY_LENGTH = 50;

export class ValidationError extends Error {}

function normalizeText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new ValidationError(`${field} 必须是字符串`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new ValidationError(`${field} 长度不能超过 ${maxLength} 个字符`);
  }
  return trimmed;
}

export function normalizeInput(input: Partial<LogInput>): LogInput {
  const content = normalizeText(input.content ?? "", "content", MAX_CONTENT_LENGTH);
  if (!content) throw new ValidationError("content 不能为空");

  const level = input.level ?? "INFO";
  if (!["DEBUG", "INFO", "WARN", "ERROR", "FATAL"].includes(level)) {
    throw new ValidationError("level 取值非法");
  }

  return {
    title: normalizeText(input.title ?? "", "title", MAX_TITLE_LENGTH),
    content,
    level: level as LogInput["level"],
    category: normalizeText(input.category ?? "", "category", MAX_CATEGORY_LENGTH) || "default",
  };
}

export interface LogFilters {
  level?: LogLevel;
  category?: string;
  keyword?: string;
  from?: number;
  to?: number;
}

/** 统一的 WHERE 构造，列表查询与导出共用，保证两者结果一致 */
function buildWhere(filters: LogFilters): { where: string; bindings: (string | number)[] } {
  const conditions: string[] = [];
  const bindings: (string | number)[] = [];

  if (filters.level) {
    conditions.push("level = ?");
    bindings.push(filters.level);
  }
  if (filters.category) {
    conditions.push("category = ?");
    bindings.push(filters.category);
  }
  if (filters.keyword) {
    // 关键词搜索无法走索引，会扫描全表，靠 LIMIT 控制代价
    conditions.push("(title LIKE ? OR content LIKE ?)");
    const like = `%${filters.keyword}%`;
    bindings.push(like, like);
  }
  if (typeof filters.from === "number" && Number.isFinite(filters.from)) {
    conditions.push("created_at >= ?");
    bindings.push(filters.from);
  }
  if (typeof filters.to === "number" && Number.isFinite(filters.to)) {
    conditions.push("created_at <= ?");
    bindings.push(filters.to);
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    bindings,
  };
}

export async function listLogs(env: Env, options: ListOptions): Promise<ListResult> {
  const limit = Number.isFinite(options.limit)
    ? Math.min(Math.max(Math.trunc(options.limit), 1), MAX_LIMIT)
    : 20;
  const offset = Number.isFinite(options.offset) ? Math.max(Math.trunc(options.offset), 0) : 0;

  const { where, bindings } = buildWhere(options);

  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM logs ${where}`)
    .bind(...bindings)
    .first<{ total: number }>();

  const { results } = await env.DB.prepare(
    `SELECT id, title, content, level, category, created_at, updated_at
     FROM logs ${where}
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(...bindings, limit, offset)
    .all<LogEntry>();

  return {
    items: results ?? [],
    total: countRow?.total ?? 0,
    limit,
    offset,
  };
}

export async function getLogById(env: Env, id: number): Promise<LogEntry | null> {
  return env.DB.prepare(
    `SELECT id, title, content, level, category, created_at, updated_at
     FROM logs WHERE id = ?`,
  )
    .bind(id)
    .first<LogEntry>();
}

export async function createLog(env: Env, raw: Partial<LogInput>): Promise<LogEntry> {
  const input = normalizeInput(raw);
  const now = Date.now();

  const inserted = await env.DB.prepare(
    `INSERT INTO logs (title, content, level, category, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     RETURNING id, title, content, level, category, created_at, updated_at`,
  )
    .bind(input.title, input.content, input.level, input.category, now, now)
    .first<LogEntry>();

  if (!inserted) throw new Error("创建日志失败");
  return inserted;
}

export async function updateLog(
  env: Env,
  id: number,
  raw: Partial<LogInput>,
): Promise<LogEntry | null> {
  const input = normalizeInput(raw);

  return env.DB.prepare(
    `UPDATE logs
     SET title = ?, content = ?, level = ?, category = ?, updated_at = ?
     WHERE id = ?
     RETURNING id, title, content, level, category, created_at, updated_at`,
  )
    .bind(input.title, input.content, input.level, input.category, Date.now(), id)
    .first<LogEntry>();
}

export async function deleteLog(env: Env, id: number): Promise<boolean> {
  const result = await env.DB.prepare(`DELETE FROM logs WHERE id = ?`).bind(id).run();
  return (result.meta?.changes ?? 0) > 0;
}

export const MAX_EXPORT_ROWS = 2000;

/**
 * 导出查询。
 * 按创建时间正序返回，适合阅读与归档。
 * 受 Workers CPU 与内存限制，单次导出最多 MAX_EXPORT_ROWS 条。
 */
export async function exportLogs(
  env: Env,
  filters: LogFilters,
): Promise<{ items: LogEntry[]; truncated: boolean }> {
  const { where, bindings } = buildWhere(filters);

  const { results } = await env.DB.prepare(
    `SELECT id, title, content, level, category, created_at, updated_at
     FROM logs ${where}
     ORDER BY created_at ASC
     LIMIT ?`,
  )
    .bind(...bindings, MAX_EXPORT_ROWS + 1)
    .all<LogEntry>();

  const rows = results ?? [];
  return {
    items: rows.slice(0, MAX_EXPORT_ROWS),
    truncated: rows.length > MAX_EXPORT_ROWS,
  };
}

export async function listCategories(env: Env): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT category FROM logs ORDER BY category ASC LIMIT 100`,
  ).all<{ category: string }>();
  return (results ?? []).map((row) => row.category);
}

/**
 * 批量导入。
 * 入参来自可信解析结果（详见 parseImport），每条都先经过 normalizeInput 校验。
 * 用 DB.batch 一次事务写入，避免逐条 INSERT 的多次往返。
 * 单批上限与导出对齐，超出的后续请求再导入即可。
 */
export async function importLogs(env: Env, rows: LogInput[]): Promise<number> {
  if (rows.length === 0) return 0;

  const now = Date.now();
  const statements = rows.map((raw) => {
    const input = normalizeInput(raw);
    return env.DB.prepare(
      `INSERT INTO logs (title, content, level, category, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(input.title, input.content, input.level, input.category, now, now);
  });

  const results = await env.DB.batch(statements);
  return results.filter((r) => (r.meta?.changes ?? 0) > 0).length;
}

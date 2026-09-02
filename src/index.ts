import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { Env, LogLevel } from "./types";
import { LOG_LEVELS } from "./types";
import {
  SESSION_COOKIE,
  createSession,
  expiredSessionCookie,
  parseCookies,
  sessionCookie,
  verifyPassword,
  verifySession,
} from "./lib/auth";
import { exportFilename, toCsv, toMarkdown } from "./lib/format";
import { parseImport } from "./lib/parseImport";
import { checkLock, clearFailures, recordFailure } from "./services/loginGuard";
import {
  ValidationError,
  createLog,
  deleteLog,
  exportLogs,
  getLogById,
  importLogs,
  listCategories,
  listLogs,
  normalizeInput,
  updateLog,
} from "./services/logService";

const app = new Hono<{ Bindings: Env }>();

/** 日志属于私密数据，任何响应都不允许被中间层缓存 */
app.use("/api/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

function isSecureRequest(url: string): boolean {
  const host = new URL(url).hostname;
  return host !== "localhost" && host !== "127.0.0.1";
}

function parseId(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** 支持 YYYY-MM-DD 或毫秒时间戳；endOfDay 用于把截止日期取到当天 23:59:59.999 */
function parseDate(value: string | undefined, endOfDay: boolean): number | undefined {
  if (!value) return undefined;
  const raw = value.trim();

  if (/^\d+$/.test(raw)) {
    const ts = Number(raw);
    return Number.isFinite(ts) ? ts : undefined;
  }

  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!matched) return undefined;

  const ts = Date.UTC(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]));
  if (!Number.isFinite(ts)) return undefined;

  return endOfDay ? ts + 24 * 60 * 60 * 1000 - 1 : ts;
}

/** 所有日志读写与分类查询接口都必须携带有效会话 */
const requireAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const cookies = parseCookies(c.req.header("Cookie"));
  const valid = await verifySession(c.env, cookies[SESSION_COOKIE]);
  if (!valid) {
    return c.json({ error: "未登录或会话已过期，请重新登录" }, 401);
  }
  await next();
};

app.use("/api/logs*", requireAuth);
app.use("/api/categories", requireAuth);
app.use("/api/export", requireAuth);
app.use("/api/import", requireAuth);

app.post("/api/login", async (c) => {
  if (!c.env.ADMIN_PASSWORD) {
    return c.json({ error: "服务端未配置 ADMIN_PASSWORD" }, 500);
  }

  const lock = await checkLock(c.env, c.req.raw);
  if (lock.locked) {
    return c.json(
      { error: `登录尝试过于频繁，请 ${lock.remainingSeconds} 秒后重试` },
      429,
    );
  }

  const body = await c.req.json<{ password?: unknown }>().catch(() => null);
  const password = typeof body?.password === "string" ? body.password : "";
  if (!password) {
    return c.json({ error: "请输入密码" }, 400);
  }

  if (!(await verifyPassword(c.env, password))) {
    const state = await recordFailure(c.env, c.req.raw);
    if (state.locked) {
      return c.json({ error: `密码错误次数过多，已锁定 ${state.remainingSeconds} 秒` }, 429);
    }
    return c.json({ error: "密码错误" }, 401);
  }

  await clearFailures(c.env, c.req.raw);
  const token = await createSession(c.env);
  c.header("Set-Cookie", sessionCookie(token, isSecureRequest(c.req.url)));
  return c.json({ ok: true });
});

app.post("/api/logout", async (c) => {
  c.header("Set-Cookie", expiredSessionCookie(isSecureRequest(c.req.url)));
  return c.json({ ok: true });
});

app.get("/api/session", async (c) => {
  const cookies = parseCookies(c.req.header("Cookie"));
  const valid = await verifySession(c.env, cookies[SESSION_COOKIE]);
  return c.json({ authenticated: valid });
});

app.get("/api/logs", async (c) => {
  const query = c.req.query();
  const level = query.level as LogLevel | undefined;

  const result = await listLogs(c.env, {
    limit: Number(query.limit ?? 20),
    offset: Number(query.offset ?? 0),
    level: level && LOG_LEVELS.includes(level) ? level : undefined,
    category: query.category || undefined,
    keyword: query.keyword || undefined,
  });

  return c.json(result);
});

app.get("/api/categories", async (c) => {
  return c.json({ categories: await listCategories(c.env) });
});

app.get("/api/export", async (c) => {
  const query = c.req.query();
  const format = query.format === "md" ? "md" : "csv";
  const level = query.level as LogLevel | undefined;

  const filters = {
    level: level && LOG_LEVELS.includes(level) ? level : undefined,
    category: query.category || undefined,
    keyword: query.keyword || undefined,
    from: parseDate(query.from, false),
    to: parseDate(query.to, true),
  };

  const { items, truncated } = await exportLogs(c.env, filters);

  const notes: string[] = [];
  if (filters.level) notes.push(`级别=${filters.level}`);
  if (filters.category) notes.push(`分类=${filters.category}`);
  if (filters.keyword) notes.push(`关键词=${filters.keyword}`);
  if (query.from) notes.push(`起始=${query.from}`);
  if (query.to) notes.push(`截止=${query.to}`);

  // CSV 加 UTF-8 BOM，否则 Excel 打开中文会乱码
  const body = format === "csv" ? `\uFEFF${toCsv(items)}` : toMarkdown(items, notes.join("、"));

  c.header(
    "Content-Type",
    format === "csv" ? "text/csv; charset=utf-8" : "text/markdown; charset=utf-8",
  );
  c.header("Content-Disposition", `attachment; filename="${exportFilename(format)}"`);
  if (truncated) c.header("X-Export-Truncated", "true");

  return c.body(body);
});

app.post("/api/import", async (c) => {
  const body = await c.req.json<{ text?: unknown; filename?: unknown }>().catch(() => null);
  if (!body || typeof body.text !== "string") {
    return c.json({ error: "请求体格式错误" }, 400);
  }

  let rows;
  try {
    rows = parseImport(body.text, typeof body.filename === "string" ? body.filename : "");
  } catch {
    return c.json({ error: "文件解析失败，请确认是导出的 CSV 或 Markdown" }, 400);
  }

  if (rows.length === 0) {
    return c.json({ imported: 0, skipped: 0 });
  }

  // 批量写入前先做长度校验，避免中途因单条非法数据整体失败
  let skipped = 0;
  const valid: typeof rows = [];
  for (const row of rows) {
    try {
      normalizeInput(row); // 触发所有校验逻辑，非法数据记 skip
      valid.push(row);
    } catch {
      skipped++;
    }
  }

  if (valid.length === 0) {
    return c.json({ imported: 0, skipped, error: "没有合法的日志记录可导入" }, 400);
  }

  const imported = await importLogs(c.env, valid);
  return c.json({ imported, skipped });
});

app.get("/api/logs/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "无效的日志 ID" }, 400);

  const entry = await getLogById(c.env, id);
  if (!entry) return c.json({ error: "日志不存在" }, 404);

  return c.json(entry);
});

app.post("/api/logs", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: "请求体格式错误" }, 400);

  try {
    const entry = await createLog(c.env, body);
    return c.json(entry, 201);
  } catch (error) {
    if (error instanceof ValidationError) {
      return c.json({ error: error.message }, 400);
    }
    console.error(JSON.stringify({ message: "create log failed", error: String(error) }));
    return c.json({ error: "创建失败" }, 500);
  }
});

app.put("/api/logs/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "无效的日志 ID" }, 400);

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: "请求体格式错误" }, 400);

  try {
    const entry = await updateLog(c.env, id, body);
    if (!entry) return c.json({ error: "日志不存在" }, 404);
    return c.json(entry);
  } catch (error) {
    if (error instanceof ValidationError) {
      return c.json({ error: error.message }, 400);
    }
    console.error(JSON.stringify({ message: "update log failed", error: String(error) }));
    return c.json({ error: "更新失败" }, 500);
  }
});

app.delete("/api/logs/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "无效的日志 ID" }, 400);

  const removed = await deleteLog(c.env, id);
  if (!removed) return c.json({ error: "日志不存在" }, 404);

  return c.json({ ok: true });
});

app.notFound((c) => c.json({ error: "接口不存在" }, 404));

app.onError((error, c) => {
  console.error(JSON.stringify({ message: "unhandled error", error: String(error) }));
  return c.json({ error: "服务器内部错误" }, 500);
});

export default app;

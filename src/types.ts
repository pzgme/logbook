export interface Env {
  DB: D1Database;
  /** 管理密码，通过 wrangler secret put ADMIN_PASSWORD 设置 */
  ADMIN_PASSWORD: string;
  /** 会话签名密钥，可选。不设置时从 ADMIN_PASSWORD 派生 */
  SESSION_SECRET?: string;
}

export interface LogEntry {
  id: number;
  title: string;
  content: string;
  level: LogLevel;
  category: string;
  created_at: number;
  updated_at: number;
}

export const LOG_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR", "FATAL"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogInput {
  title: string;
  content: string;
  level: LogLevel;
  category: string;
}

export interface ListOptions {
  limit: number;
  offset: number;
  level?: LogLevel;
  category?: string;
  keyword?: string;
}

export interface ListResult {
  items: LogEntry[];
  total: number;
  limit: number;
  offset: number;
}

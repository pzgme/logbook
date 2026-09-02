import type { LogInput, LogLevel } from "../types";

const VALID_LEVELS: LogLevel[] = ["DEBUG", "INFO", "WARN", "ERROR", "FATAL"];

/** 去除 CSV 单元格里的首尾引号并还原转义 */
function unquoteCsv(field: string): string {
  let s = field.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1).replace(/""/g, '"');
  }
  return s;
}

/** 还原导出时的公式注入防护（前置单引号）与 BOM */
function cleanValue(value: string): string {
  let s = value.replace(/^﻿/, "");
  if (s.startsWith("'") && /^[=+\-@\t\r]/.test(s.slice(1))) {
    s = s.slice(1);
  }
  return s;
}

/** 宽松判断时间戳字段，仅用于跳过导出头部里的时间列（我们忽略时间，统一用导入时刻） */
function parseCsv(text: string): LogInput[] {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];

  const rows: LogInput[] = [];
  // 跳过表头（首列通常是 ID 或 时间）
  const start = /^"?ID"?\s*,/.test(lines[0]) || /^"?时间/.test(lines[0]) ? 1 : 0;

  for (let i = start; i < lines.length; i++) {
    // 简化 CSV 切片：依赖逗号分隔，字段内逗号已用引号包裹
    const parts: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (const ch of lines[i]) {
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === "," && !inQuotes) {
        parts.push(cur);
        cur = "";
      } else cur += ch;
    }
    parts.push(cur);
    if (parts.length < 6) continue;

    const [, , levelRaw, category, title, content] = parts.map(unquoteCsv);
    const level = (VALID_LEVELS.includes(levelRaw as LogLevel) ? levelRaw : "INFO") as LogLevel;

    rows.push({
      title: cleanValue(title),
      content: cleanValue(content),
      level,
      category: cleanValue(category) || "default",
    });
  }
  return rows;
}

/** 解析本系统导出的 Markdown 格式：按 `## [LEVEL] 标题` 分节 */
function parseMarkdown(text: string): LogInput[] {
  const lines = text.split(/\r\n|\n|\r/);
  const rows: LogInput[] = [];
  let pending: { level: LogLevel; title: string; category: string; contentLines: string[] } | null = null;

  const flush = () => {
    if (!pending) return;
    const content = pending.contentLines.join("\n").trim();
    if (content || pending.title) {
      rows.push({
        title: pending.title,
        content,
        level: pending.level,
        category: pending.category || "default",
      });
    }
    pending = null;
  };

  for (const line of lines) {
    const head = /^##\s+\[([A-Z]+)\]\s*(.*)$/.exec(line);
    if (head) {
      flush();
      const level = (VALID_LEVELS.includes(head[1] as LogLevel) ? head[1] : "INFO") as LogLevel;
      pending = { level, title: head[2].trim(), category: "default", contentLines: [] };
      continue;
    }
    if (!pending) continue;

    const cat = /^- 分类[:：]\s*(.*)$/.exec(line);
    if (cat) {
      pending.category = cat[1].trim() || "default";
      continue;
    }
    // 跳过 ID / 时间 / URL 等元数据行
    if (/^- (ID|时间|URL)[:：]/.test(line)) continue;
    pending.contentLines.push(line);
  }
  flush();
  return rows;
}

/**
 * 解析导入文件，按扩展名推断格式。
 * 返回可信的 LogInput 数组——字段校验与长度限制在 importLogs 内统一进行。
 */
export function parseImport(text: string, filename = ""): LogInput[] {
  const isMd = /\.(md|markdown)$/i.test(filename) || /^#\s/.test(text.trim());
  return isMd ? parseMarkdown(text) : parseCsv(text);
}

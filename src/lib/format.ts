import type { LogEntry } from "../types";

const pad = (value: number) => String(value).padStart(2, "0");

/** 统一按 UTC 输出，避免不同环境的时区差异导致时间错位 */
export function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    ` ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/**
 * CSV 字段转义（RFC 4180），并防御公式注入。
 * 以 = + - @ 制表符 回车 开头的单元格会被 Excel / Sheets 当作公式执行，
 * 这是导出功能的经典漏洞，必须前置单引号中和。
 */
function csvField(value: string): string {
  let text = value ?? "";
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  if (/[",\n\r]/.test(text)) {
    text = `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function toCsv(items: LogEntry[]): string {
  const lines: string[] = [["ID", "时间(UTC)", "级别", "分类", "标题", "内容"].join(",")];

  for (const item of items) {
    lines.push(
      [
        String(item.id),
        formatTimestamp(item.created_at),
        item.level,
        item.category,
        item.title,
        item.content,
      ]
        .map(csvField)
        .join(","),
    );
  }

  return lines.join("\r\n");
}

export function toMarkdown(items: LogEntry[], filterNote: string): string {
  const lines: string[] = [
    "# Logbook 导出",
    "",
    `- 导出时间：${formatTimestamp(Date.now())} UTC`,
    `- 记录条数：${items.length}`,
  ];

  if (filterNote) lines.push(`- 筛选条件：${filterNote}`);
  lines.push("");

  for (const item of items) {
    lines.push(`## [${item.level}] ${item.title || "(无标题)"}`);
    lines.push("");
    lines.push(`- ID：${item.id}`);
    lines.push(`- 时间：${formatTimestamp(item.created_at)} UTC`);
    lines.push(`- 分类：${item.category}`);
    lines.push("");
    lines.push(item.content);
    lines.push("");
  }

  return lines.join("\n");
}

export function exportFilename(format: "csv" | "md"): string {
  const d = new Date();
  const stamp =
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
  return `logbook-${stamp}.${format}`;
}

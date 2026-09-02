import type { Env } from "../types";

const MAX_FAILS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 30 * 60 * 1000;

export interface LockState {
  locked: boolean;
  remainingSeconds: number;
}

/**
 * 登录失败频率限制。
 * 只在失败时写库，登录成功或正常使用期间不产生写操作。
 */

function clientIp(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",")[0].trim() ??
    "unknown"
  );
}

export async function checkLock(env: Env, request: Request): Promise<LockState> {
  const ip = clientIp(request);
  const row = await env.DB.prepare(
    `SELECT fails, locked_until, updated_at FROM login_attempts WHERE ip = ?`,
  )
    .bind(ip)
    .first<{ fails: number; locked_until: number; updated_at: number }>();

  if (!row) return { locked: false, remainingSeconds: 0 };

  const now = Date.now();

  if (row.locked_until > now) {
    return { locked: true, remainingSeconds: Math.ceil((row.locked_until - now) / 1000) };
  }

  // 锁定已过期，或失败记录超出统计窗口，直接清零，避免计数永久累积
  if (row.locked_until > 0 || now - row.updated_at > ATTEMPT_WINDOW_MS) {
    await env.DB.prepare(
      `UPDATE login_attempts SET fails = 0, locked_until = 0, updated_at = ? WHERE ip = ?`,
    )
      .bind(now, ip)
      .run();
  }

  return { locked: false, remainingSeconds: 0 };
}

export async function recordFailure(env: Env, request: Request): Promise<LockState> {
  const ip = clientIp(request);
  const now = Date.now();

  const row = await env.DB.prepare(
    `SELECT fails FROM login_attempts WHERE ip = ?`,
  )
    .bind(ip)
    .first<{ fails: number }>();

  const fails = (row?.fails ?? 0) + 1;

  if (fails >= MAX_FAILS) {
    const lockedUntil = now + LOCK_DURATION_MS;
    await env.DB.prepare(
      `INSERT INTO login_attempts (ip, fails, locked_until, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(ip) DO UPDATE SET fails = ?, locked_until = ?, updated_at = ?`,
    )
      .bind(ip, fails, lockedUntil, now, fails, lockedUntil, now)
      .run();

    return { locked: true, remainingSeconds: Math.ceil(LOCK_DURATION_MS / 1000) };
  }

  await env.DB.prepare(
    `INSERT INTO login_attempts (ip, fails, locked_until, updated_at)
     VALUES (?, ?, 0, ?)
     ON CONFLICT(ip) DO UPDATE SET fails = ?, updated_at = ?`,
  )
    .bind(ip, fails, now, fails, now)
    .run();

  return { locked: false, remainingSeconds: 0 };
}

export async function clearFailures(env: Env, request: Request): Promise<void> {
  const ip = clientIp(request);
  await env.DB.prepare(`DELETE FROM login_attempts WHERE ip = ?`).bind(ip).run();
}

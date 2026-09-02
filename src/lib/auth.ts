import type { Env } from "../types";
import { decodeUtf8, fromBase64Url, hmacSign, sha256, timingSafeEqual, toBase64Url } from "./crypto";

export const SESSION_COOKIE = "lb_session";
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/**
 * 会话签名密钥。
 * 未单独配置 SESSION_SECRET 时从管理密码派生，
 * 保证签名密钥与密码本体不是同一个值。
 */
async function sessionSecret(env: Env): Promise<string> {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  const derived = await sha256(`logbook:session:${env.ADMIN_PASSWORD}`);
  return toBase64Url(derived);
}

/** 先各自哈希再比较，长度恒定，配合 timingSafeEqual 防御时序攻击 */
export async function verifyPassword(env: Env, input: string): Promise<boolean> {
  const [inputHash, expectedHash] = await Promise.all([
    sha256(`logbook:pwd:${input}`),
    sha256(`logbook:pwd:${env.ADMIN_PASSWORD}`),
  ]);
  return timingSafeEqual(toBase64Url(inputHash), toBase64Url(expectedHash));
}

export async function createSession(env: Env): Promise<string> {
  const payload = toBase64Url(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS }),
  );
  const signature = await hmacSign(await sessionSecret(env), payload);
  return `${payload}.${signature}`;
}

export async function verifySession(env: Env, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;

  const [payload, signature] = parts;
  const expected = await hmacSign(await sessionSecret(env), payload);
  if (!timingSafeEqual(signature, expected)) return false;

  try {
    const claims = JSON.parse(decodeUtf8(fromBase64Url(payload))) as { exp?: unknown };
    return typeof claims.exp === "number" && claims.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}

export function sessionCookie(token: string, secure: boolean): string {
  const flags = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (secure) flags.push("Secure");
  return flags.join("; ");
}

export function expiredSessionCookie(secure: boolean): string {
  const flags = [
    `${SESSION_COOKIE}=`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    "Max-Age=0",
  ];
  if (secure) flags.push("Secure");
  return flags.join("; ");
}

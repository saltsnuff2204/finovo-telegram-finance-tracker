import { env } from "cloudflare:workers";

export type TelegramUser = {
  id: number;
  first_name: string;
  username?: string;
};

function bytesToHex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function sameHex(left: string, right: string) {
  if (!/^[a-f0-9]{64}$/i.test(left) || right.length !== 64) return false;
  let difference = 0;
  for (let i = 0; i < 64; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

async function hmac(key: ArrayBuffer | string, value: string) {
  const rawKey = typeof key === "string" ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value));
}

export async function validateTelegramInitData(raw: string): Promise<TelegramUser | null> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token || !raw || raw.length > 8192) return null;

  const params = new URLSearchParams(raw);
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) return null;
  const receivedHash = params.get("hash");
  const rawAuthDate = params.get("auth_date");
  if (!receivedHash || !rawAuthDate || !/^\d+$/.test(rawAuthDate)) return null;
  const authDate = Number(rawAuthDate);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(authDate) || authDate < now - 86400 || authDate > now + 300) return null;

  params.delete("hash");
  // Telegram's bot-token HMAC covers every remaining field, including signature.
  const checkString = [...params.entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = await hmac("WebAppData", token);
  const calculatedHash = bytesToHex(await hmac(secret, checkString));
  if (!sameHex(calculatedHash, receivedHash.toLowerCase())) return null;

  try {
    const user: unknown = JSON.parse(params.get("user") ?? "null");
    if (!user || typeof user !== "object" || Array.isArray(user)) return null;
    const candidate = user as Record<string, unknown>;
    if (!Number.isSafeInteger(candidate.id) || Number(candidate.id) <= 0
      || typeof candidate.first_name !== "string" || !candidate.first_name.trim()
      || candidate.first_name.length > 256
      || (candidate.username !== undefined && typeof candidate.username !== "string")) return null;
    return { id: candidate.id as number, first_name: candidate.first_name, username: candidate.username as string | undefined };
  } catch {
    return null;
  }
}

export async function userFromRequest(request: Request): Promise<TelegramUser | null> {
  const initData = request.headers.get("x-telegram-init-data") ?? "";
  return validateTelegramInitData(initData);
}

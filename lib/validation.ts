export const supportedCurrencies = ["KZT", "RUB", "USD", "EUR"] as const;
export type Currency = (typeof supportedCurrencies)[number];

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return asRecord(await request.json());
  } catch {
    return null;
  }
}

export function parseAmount(value: unknown): number | null {
  const amount = parseNonnegativeAmount(value);
  return amount !== null && amount > 0 ? amount : null;
}

export function parseNonnegativeAmount(value: unknown): number | null {
  if (value === undefined || value === "") return 0;
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d+(?:[.,]\d{1,2})?$/.test(value.trim())) return null;
  const amount = typeof value === "string" ? Number(value.trim().replace(",", ".")) : value;
  return Number.isFinite(amount) && amount >= 0 && amount <= 1_000_000_000_000
    && Math.abs(Math.round(amount * 100) - amount * 100) < 0.00001 ? amount : null;
}

export function parseCurrency(value: unknown): Currency | null {
  if (value === undefined) return "KZT";
  if (typeof value !== "string") return null;
  const currency = value.trim().toUpperCase();
  return supportedCurrencies.find((item) => item === currency) ?? null;
}

export function parseOptionalDate(value: unknown): Date | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 40) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 2000 && date.getUTCFullYear() <= 2100
    ? date : undefined;
}

export function parseText(value: unknown, maxLength: number, required = false): string | null {
  if (value === undefined && !required) return "";
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length > maxLength || (required && !text)) return null;
  return text;
}

export function periodStart(period: "today" | "month", now = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Qyzylorda", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (key: string) => Number(parts.find((part) => part.type === key)?.value);
  // Qyzylorda is UTC+5. These boundaries match the user's local calendar day.
  return new Date(Date.UTC(get("year"), get("month") - 1, period === "month" ? 1 : get("day"), -5));
}

export function localMonth(value: string | null, now = new Date()): {
  month: string; start: Date; end: Date;
} | null {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Qyzylorda", year: "numeric", month: "2-digit",
  }).formatToParts(now);
  const current = `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}`;
  const month = value ?? current;
  if (!/^(20\d\d|2100)-(0[1-9]|1[0-2])$/.test(month)) return null;
  const [year, monthNumber] = month.split("-").map(Number);
  return {
    month,
    start: new Date(Date.UTC(year, monthNumber - 1, 1, -5)),
    end: new Date(Date.UTC(year, monthNumber, 1, -5)),
  };
}

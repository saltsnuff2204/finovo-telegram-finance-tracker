import { and, eq, gte, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { getDb } from "@/db";
import { transactions, users } from "@/db/schema";
import { getApiUser, unauthorized } from "@/lib/api-user";
import { asRecord, parseAmount, parseCurrency, parseText } from "@/lib/validation";

const MAX_BODY_BYTES = 1_048_576;
const MAX_ROWS = 500;
// Leave room for the user-id parameter on runtimes with a 100-variable SQL cap.
const QUERY_CHUNK_SIZE = 50;
const INSERT_CHUNK_SIZE = 50;
const DAY_MS = 86_400_000;

type ImportEntry = {
  type: "income" | "expense";
  amount: number;
  currency: "KZT" | "RUB" | "USD" | "EUR";
  category: string;
  note: string;
  happenedAt: Date;
  sourceKey: string;
  fingerprint: string;
  firstOccurrence: boolean;
};

function error(message: string, status = 400) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

async function readBoundedBody(request: Request): Promise<Record<string, unknown> | "too-large" | null> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return "too-large";
  if (!request.body) return null;

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        return "too-large";
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function parseHappenedAt(value: unknown): Date | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const match = /^(20\d\d|2100)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?:T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d))?$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1
    || calendarDate.getUTCDate() !== day) return null;
  // A date-only bank row represents local midnight, not UTC midnight.
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00+05:00` : value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

async function hashSourceKey(sourceKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sourceKey));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function localDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Qyzylorda", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const get = (part: string) => parts.find((item) => item.type === part)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function creditMatchKey(date: Date, amount: number, currency: string): string {
  return `${localDate(date)}|${Math.round(amount * 100)}|${currency}`;
}

function existingMatchKey(date: Date, type: string, amount: number, currency: string): string {
  return `${localDate(date)}|${type}|${Math.round(amount * 100)}|${currency}`;
}

export async function POST(request: Request) {
  const user = await getApiUser(request);
  if (!user) return unauthorized();

  const body = await readBoundedBody(request);
  if (body === "too-large") return error("Файл импорта слишком большой (максимум 1 МБ)", 413);
  if (!body || (body.action !== "preview" && body.action !== "commit") || !Array.isArray(body.transactions)) {
    return error("Некорректные данные импорта");
  }
  if (body.transactions.length > MAX_ROWS) return error("За один раз можно импортировать не больше 500 операций", 413);

  const entries: ImportEntry[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < body.transactions.length; index += 1) {
    const row = asRecord(body.transactions[index]);
    if (!row) return error(`Строка ${index + 1}: некорректная операция`);
    const type = row.type;
    const amount = typeof row.amount === "number" ? parseAmount(row.amount) : null;
    const currency = typeof row.currency === "string" ? parseCurrency(row.currency) : null;
    const category = parseText(row.category, 40, true);
    const note = parseText(row.note, 160);
    const happenedAt = parseHappenedAt(row.happenedAt);
    const sourceKey = parseText(row.sourceKey, 1000, true);
    if ((type !== "income" && type !== "expense") || amount === null || !currency
      || category === null || note === null || !happenedAt || !sourceKey) {
      return error(`Строка ${index + 1}: проверьте тип, сумму, валюту, категорию, дату и ключ операции`);
    }
    const fingerprint = await hashSourceKey(sourceKey);
    const firstOccurrence = !seen.has(fingerprint);
    seen.add(fingerprint);
    entries.push({ type, amount, currency, category, note, happenedAt, sourceKey, fingerprint, firstOccurrence });
  }

  if (entries.length === 0) {
    return Response.json({ rows: [], imported: 0, duplicates: 0 }, { headers: { "Cache-Control": "no-store" } });
  }

  const db = getDb();
  const userId = String(user.id);
  const uniqueFingerprints = [...new Set(entries.map((entry) => entry.fingerprint))];
  const existing = new Set<string>();
  for (let offset = 0; offset < uniqueFingerprints.length; offset += QUERY_CHUNK_SIZE) {
    const batch = uniqueFingerprints.slice(offset, offset + QUERY_CHUNK_SIZE);
    const found = await db.select({ fingerprint: transactions.importFingerprint }).from(transactions)
      .where(and(eq(transactions.userId, userId), inArray(transactions.importFingerprint, batch)));
    for (const row of found) if (row.fingerprint) existing.add(row.fingerprint);
  }

  const minTime = Math.min(...entries.map((entry) => entry.happenedAt.getTime()));
  const maxTime = Math.max(...entries.map((entry) => entry.happenedAt.getTime()));
  const creditTransactions = await db.select({
    amount: transactions.amount,
    currency: transactions.currency,
    happenedAt: transactions.happenedAt,
  }).from(transactions).where(and(
    eq(transactions.userId, userId),
    isNotNull(transactions.creditInstallmentId),
    gte(transactions.happenedAt, new Date(minTime - DAY_MS)),
    lt(transactions.happenedAt, new Date(maxTime + DAY_MS * 2)),
  ));
  const creditMatches = new Set(creditTransactions.map((row) => creditMatchKey(row.happenedAt, row.amount, row.currency)));
  const existingTransactions = await db.select({
    type: transactions.type,
    amount: transactions.amount,
    currency: transactions.currency,
    happenedAt: transactions.happenedAt,
  }).from(transactions).where(and(
    eq(transactions.userId, userId),
    isNull(transactions.creditInstallmentId),
    gte(transactions.happenedAt, new Date(minTime - DAY_MS)),
    lt(transactions.happenedAt, new Date(maxTime + DAY_MS * 2)),
  ));
  const possibleMatches = new Set(existingTransactions.map((row) =>
    existingMatchKey(row.happenedAt, row.type, row.amount, row.currency)));

  let inserted = new Set<string>();
  if (body.action === "commit") {
    const candidates = entries.filter((entry) => entry.firstOccurrence && !existing.has(entry.fingerprint));
    if (candidates.length > 0) {
      await db.insert(users).values({
        id: userId, firstName: user.first_name, username: user.username ?? null, createdAt: new Date(),
      }).onConflictDoNothing();
      const now = new Date();
      for (let offset = 0; offset < candidates.length; offset += INSERT_CHUNK_SIZE) {
        const batch = candidates.slice(offset, offset + INSERT_CHUNK_SIZE);
        const created = await db.insert(transactions).values(batch.map((entry) => ({
          userId,
          type: entry.type,
          amount: entry.amount,
          currency: entry.currency,
          category: entry.category,
          note: entry.note,
          happenedAt: entry.happenedAt,
          createdAt: now,
          importFingerprint: entry.fingerprint,
        }))).onConflictDoNothing({ target: [transactions.userId, transactions.importFingerprint] })
          .returning({ fingerprint: transactions.importFingerprint });
        inserted = new Set([...inserted, ...created.map((row) => row.fingerprint).filter((value): value is string => !!value)]);
      }
    }
  }

  const rows = entries.map((entry) => ({
    sourceKey: entry.sourceKey,
    duplicate: !entry.firstOccurrence || (body.action === "preview"
      ? existing.has(entry.fingerprint) : !inserted.has(entry.fingerprint)),
    possibleCreditDuplicate: entry.type === "expense"
      && creditMatches.has(creditMatchKey(entry.happenedAt, entry.amount, entry.currency)),
    possibleExistingDuplicate: !existing.has(entry.fingerprint) && possibleMatches.has(existingMatchKey(
      entry.happenedAt, entry.type, entry.amount, entry.currency)),
  }));
  return Response.json({
    rows,
    imported: body.action === "commit" ? inserted.size : 0,
    duplicates: rows.filter((row) => row.duplicate).length,
  }, { headers: { "Cache-Control": "no-store" } });
}

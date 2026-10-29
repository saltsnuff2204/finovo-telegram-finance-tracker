import { env } from "cloudflare:workers";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { parseOperation } from "@/lib/finance-parser";
import { sendTelegramMessage } from "@/lib/telegram-client";
import { insertTelegramTransactionSql, recordTelegramUpdateSql } from "@/lib/telegram-dedupe";
import { periodStart, supportedCurrencies } from "@/lib/validation";

type TelegramUpdate = {
  update_id?: number;
  message?: {
    chat?: { id?: number; type?: string };
    from?: { id?: number; first_name?: string; username?: string };
    text?: string;
  };
};

function sameSecret(expected: string, received: string | null) {
  if (!received || expected.length !== received.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  return difference === 0;
}

function money(value: number, currency: string) {
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(value)} ${currency}`;
}

async function summary(userId: number, period: "today" | "month") {
  if (!env.DB) throw new Error("D1 binding DB is not configured");
  const start = Math.floor(periodStart(period).getTime() / 1000);
  const data = await env.DB.prepare(
    "SELECT currency, type, COALESCE(SUM(amount), 0) AS total FROM transactions WHERE user_id = ? AND happened_at >= ? GROUP BY currency, type",
  ).bind(String(userId), start).all<{ currency: string; type: string; total: number }>();
  const currencies = [...supportedCurrencies].filter((currency) =>
    currency === "KZT" || data.results.some((row) => row.currency === currency));
  const lines = currencies.map((currency) => {
    const income = Number(data.results.find((row) => row.currency === currency && row.type === "income")?.total ?? 0);
    const expense = Number(data.results.find((row) => row.currency === currency && row.type === "expense")?.total ?? 0);
    return `${currency}: доходы ${money(income, currency)}, расходы ${money(expense, currency)}, разница ${money(income - expense, currency)}`;
  });
  return `${period === "today" ? "Сегодня" : "В этом месяце"}:\n${lines.join("\n")}`;
}

export async function POST(request: Request) {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return new Response("Webhook secret is not configured", { status: 503 });
  if (!sameSecret(secret, request.headers.get("x-telegram-bot-api-secret-token"))) {
    return new Response("Forbidden", { status: 403 });
  }

  let update: TelegramUpdate;
  try {
    const raw = await request.text();
    if (raw.length > 65536) return new Response("Payload too large", { status: 413 });
    update = JSON.parse(raw) as TelegramUpdate;
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const message = update?.message;
  const user = message?.from;
  const chat = message?.chat;
  if (!message || !user || !chat || chat.type !== "private" || chat.id !== user.id
    || !Number.isSafeInteger(user.id) || Number(user.id) <= 0 || typeof user.first_name !== "string"
    || typeof message.text !== "string") return new Response("ok");

  const text = message.text.trim();
  const command = text.split(/\s+/, 1)[0];
  if (command === "/start" || command === "/help") {
    await sendTelegramMessage(chat.id!, "Привет! Я записываю личные финансы.\n\nОтправь сообщение, например:\n• кофе 1 200\n• такси 3500\n• + зарплата 450000\n• кофе 5 USD\n\nКоманды: /today — за сегодня, /month — за месяц.", true);
    return new Response("ok");
  }

  if (command === "/today" || command === "/month") {
    await sendTelegramMessage(chat.id!, await summary(user.id!, command === "/today" ? "today" : "month"), true);
    return new Response("ok");
  }

  if (text.startsWith("/")) {
    await sendTelegramMessage(chat.id!, "Не знаю такую команду. Отправь /help для подсказки.");
    return new Response("ok");
  }

  const operation = parseOperation(text);
  if (!operation) {
    await sendTelegramMessage(chat.id!, "Не нашёл сумму или валюту. Попробуй: «кофе 1200», «кофе 5 USD» или «+ зарплата 450000».");
    return new Response("ok");
  }
  if (!Number.isSafeInteger(update.update_id) || Number(update.update_id) < 0) {
    return new Response("Bad request", { status: 400 });
  }

  const db = getDb();
  await db.insert(users).values({
    id: String(user.id),
    firstName: user.first_name.slice(0, 256),
    username: user.username ?? null,
    createdAt: new Date(),
  }).onConflictDoNothing();
  const now = Math.floor(Date.now() / 1000);
  // D1 batches are atomic. A receipt survives financial resets, and the first
  // statement refuses to recreate a transaction for any recorded update ID.
  // The second statement also backfills a receipt for a pre-migration duplicate.
  const [inserted] = await db.$client.batch([
    db.$client.prepare(insertTelegramTransactionSql)
      .bind(String(user.id), operation.type, operation.amount, operation.currency,
        operation.category, operation.note, update.update_id, now, now, update.update_id),
    db.$client.prepare(recordTelegramUpdateSql)
      .bind(update.update_id, String(user.id), now, update.update_id, String(user.id)),
  ]);

  if (!inserted.meta.changes) {
    await sendTelegramMessage(chat.id!, "Эта операция уже записана.");
    return new Response("ok");
  }
  await sendTelegramMessage(chat.id!, `${operation.type === "income" ? "🟢 Доход" : "🔴 Расход"} ${money(operation.amount, operation.currency)} записан\n${operation.category}${operation.note ? ` · ${operation.note}` : ""}`, true);
  return new Response("ok");
}

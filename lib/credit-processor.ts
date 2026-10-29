import { env } from "cloudflare:workers";
import { sendTelegramMessage } from "@/lib/telegram-client";

const TIME_ZONE = "Asia/Qyzylorda";
const REMINDER_DAYS = [7, 3, 1] as const;

type InstallmentRow = {
  id: number;
  obligation_id: number;
  user_id: string;
  installment_number: number;
  amount: number;
  currency: string;
  due_at: number;
  title: string;
  total_months: number;
  reminder_7_at: number | null;
  reminder_3_at: number | null;
  reminder_1_at: number | null;
};

function localDate(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

function dayNumber(isoDate: string) {
  return Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / 86_400_000);
}

function money(amount: number, currency: string) {
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(amount)} ${currency}`;
}

function reminderColumn(days: (typeof REMINDER_DAYS)[number]): "reminder_7_at" | "reminder_3_at" | "reminder_1_at" {
  return days === 7 ? "reminder_7_at" : days === 3 ? "reminder_3_at" : "reminder_1_at";
}

// Each batch is a D1 transaction. The installment and transaction uniqueness
// constraints make retries safe after a timeout or a second scheduled run.
async function postInstallment(db: D1Database, row: InstallmentRow, postedAt: number) {
  const note = `Платёж по кредиту «${row.title}» · ${row.installment_number}/${row.total_months}`;
  const statements = [
    db.prepare(`INSERT OR IGNORE INTO transactions
      (user_id, type, amount, currency, category, note, credit_installment_id, happened_at, created_at)
      SELECT ci.user_id, 'expense', ci.amount, ci.currency, 'Кредиты', ?, ci.id, ci.due_at, ?
      FROM credit_installments ci JOIN obligations o ON o.id = ci.obligation_id
      WHERE ci.id = ? AND ci.posted_at IS NULL AND o.kind = 'credit' AND o.status = 'active'`)
      .bind(note, postedAt, row.id),
    db.prepare(`UPDATE obligations SET
      paid_months = min(total_months, paid_months + 1),
      current_amount = min(amount, current_amount + (SELECT amount FROM credit_installments WHERE id = ?)),
      next_payment_date = (SELECT min(due_at) FROM credit_installments
        WHERE obligation_id = ? AND id <> ? AND posted_at IS NULL),
      status = CASE WHEN paid_months + 1 >= total_months THEN 'done' ELSE status END
      WHERE id = ? AND kind = 'credit' AND status = 'active'
        AND EXISTS (SELECT 1 FROM credit_installments WHERE id = ? AND posted_at IS NULL)
        AND EXISTS (SELECT 1 FROM transactions WHERE credit_installment_id = ?)`)
      .bind(row.id, row.obligation_id, row.id, row.obligation_id, row.id, row.id),
    db.prepare(`UPDATE credit_installments SET posted_at = ?
      WHERE id = ? AND posted_at IS NULL
        AND EXISTS (SELECT 1 FROM transactions WHERE credit_installment_id = ?)`)
      .bind(postedAt, row.id, row.id),
  ];
  const result = await db.batch(statements);
  return Number(result[2]?.meta?.changes ?? 0) > 0;
}

async function sendReminder(db: D1Database, row: InstallmentRow, days: (typeof REMINDER_DAYS)[number], nowSec: number) {
  const column = reminderColumn(days);
  // Column names are selected exclusively from the constant map above.
  const claim = await db.prepare(`UPDATE credit_installments SET ${column} = ?
    WHERE id = ? AND ${column} IS NULL AND posted_at IS NULL RETURNING id`)
    .bind(nowSec, row.id).first<{ id: number }>();
  if (!claim) return false;
  try {
    const chatId = Number(row.user_id);
    if (!Number.isSafeInteger(chatId) || chatId <= 0) throw new Error("Invalid Telegram user ID");
    const due = localDate(new Date(row.due_at * 1000)).split("-").reverse().join(".");
    await sendTelegramMessage(chatId,
      `Напоминание: через ${days} ${days === 7 ? "дней" : days === 3 ? "дня" : "день"} платёж по кредиту «${row.title}» — ${money(row.amount, row.currency)}.\nДата: ${due} · платёж ${row.installment_number}/${row.total_months}.`,
      true);
    return true;
  } catch (error) {
    // Release failed claims so an operator can retry on the same reminder day.
    await db.prepare(`UPDATE credit_installments SET ${column} = NULL WHERE id = ? AND ${column} = ?`)
      .bind(row.id, nowSec).run();
    throw error;
  }
}

export async function processCreditSchedule(now = new Date()) {
  const db = env.DB;
  if (!db) throw new Error("D1 binding DB is not configured");
  const nowSec = Math.floor(now.getTime() / 1000);
  const today = dayNumber(localDate(now));
  const due = await db.prepare(`SELECT ci.id, ci.obligation_id, ci.user_id, ci.installment_number,
      ci.amount, ci.currency, ci.due_at, ci.reminder_7_at, ci.reminder_3_at, ci.reminder_1_at,
      o.title, o.total_months
    FROM credit_installments ci JOIN obligations o ON o.id = ci.obligation_id
    WHERE ci.posted_at IS NULL AND ci.due_at <= ? AND o.kind = 'credit' AND o.status = 'active'
    ORDER BY ci.due_at, ci.id LIMIT 200`).bind(nowSec).all<InstallmentRow>();

  let posted = 0;
  for (const row of due.results) {
    if (await postInstallment(db, row, nowSec)) posted++;
  }

  const upcoming = await db.prepare(`SELECT ci.id, ci.obligation_id, ci.user_id, ci.installment_number,
      ci.amount, ci.currency, ci.due_at, ci.reminder_7_at, ci.reminder_3_at, ci.reminder_1_at,
      o.title, o.total_months
    FROM credit_installments ci JOIN obligations o ON o.id = ci.obligation_id
    WHERE ci.posted_at IS NULL AND ci.due_at > ? AND ci.due_at <= ?
      AND o.kind = 'credit' AND o.status = 'active'
    ORDER BY ci.due_at, ci.id LIMIT 200`)
    .bind(nowSec, nowSec + 8 * 86_400).all<InstallmentRow>();

  let reminders = 0;
  let reminderFailures = 0;
  for (const row of upcoming.results) {
    const days = dayNumber(localDate(new Date(row.due_at * 1000))) - today;
    if (!REMINDER_DAYS.includes(days as (typeof REMINDER_DAYS)[number])) continue;
    const offset = days as (typeof REMINDER_DAYS)[number];
    if (row[reminderColumn(offset)] !== null) continue;
    try {
      if (await sendReminder(db, row, offset, nowSec)) reminders++;
    } catch (error) {
      reminderFailures++;
      console.error("Credit reminder delivery failed", row.id, error instanceof Error ? error.message : "unknown error");
    }
  }
  return { checkedAt: now.toISOString(), timeZone: TIME_ZONE, posted, reminders, reminderFailures,
    moreDue: due.results.length === 200, moreUpcoming: upcoming.results.length === 200 };
}

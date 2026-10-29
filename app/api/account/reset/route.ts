import { getDb } from "@/db";
import { getApiUser, unauthorized } from "@/lib/api-user";
import { preserveTelegramUpdatesSql } from "@/lib/telegram-dedupe";
import { readJsonObject } from "@/lib/validation";

const CONFIRMATION = "СБРОСИТЬ";
const responseHeaders = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  const user = await getApiUser(request);
  if (!user) {
    const response = unauthorized();
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  const body = await readJsonObject(request);
  if (!body || body.confirmation !== CONFIRMATION) {
    return Response.json({ error: `Для сброса введите ${CONFIRMATION}` }, {
      status: 400,
      headers: responseHeaders,
    });
  }

  const userId = String(user.id);
  const db = getDb().$client;
  // D1 executes a batch atomically. Preserve webhook update IDs before deleting
  // their transactions, so a delayed Telegram retry cannot restore old data.
  // There are no foreign-key cascades in this schema.
  const [, deletedTransactions, deletedInstallments, deletedObligations, deletedCategories] = await db.batch([
    db.prepare(preserveTelegramUpdatesSql).bind(userId),
    db.prepare("DELETE FROM transactions WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM credit_installments WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM obligations WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM categories WHERE user_id = ?").bind(userId),
  ]);

  return Response.json({
    deleted: {
      transactions: deletedTransactions.meta.changes,
      creditInstallments: deletedInstallments.meta.changes,
      obligations: deletedObligations.meta.changes,
      categories: deletedCategories.meta.changes,
    },
  }, { headers: responseHeaders });
}

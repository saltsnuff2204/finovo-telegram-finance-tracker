import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { transactions } from "@/db/schema";
import { getApiUser, unauthorized } from "@/lib/api-user";

type Context = { params: Promise<{ id: string }> };

export async function DELETE(request: Request, context: Context) {
  const user = await getApiUser(request);
  if (!user) return unauthorized();
  const { id: rawId } = await context.params;
  if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(Number(rawId))) {
    return Response.json({ error: "Некорректный ID" }, { status: 400 });
  }

  const [deleted] = await getDb().delete(transactions)
    .where(and(eq(transactions.id, Number(rawId)), eq(transactions.userId, String(user.id))))
    .returning({ id: transactions.id });
  return deleted ? new Response(null, { status: 204 })
    : Response.json({ error: "Операция не найдена" }, { status: 404 });
}

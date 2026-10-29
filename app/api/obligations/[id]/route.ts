import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { creditInstallments, obligations } from "@/db/schema";
import { getApiUser, unauthorized } from "@/lib/api-user";
import { parseNonnegativeAmount, readJsonObject } from "@/lib/validation";

type Context = { params: Promise<{ id: string }> };

async function recordId(context: Context) {
  const { id } = await context.params;
  if (!/^[1-9]\d*$/.test(id)) return null;
  const number = Number(id);
  return Number.isSafeInteger(number) ? number : null;
}

export async function PATCH(request: Request, context: Context) {
  const user = await getApiUser(request);
  if (!user) return unauthorized();
  const id = await recordId(context);
  if (id === null) return Response.json({ error: "Некорректный ID" }, { status: 400 });
  const body = await readJsonObject(request);
  if (!body) return Response.json({ error: "Некорректный JSON" }, { status: 400 });
  if (!("currentAmount" in body) && !("status" in body)) {
    return Response.json({ error: "Укажите сумму или статус" }, { status: 400 });
  }

  const db = getDb();
  const where = and(eq(obligations.id, id), eq(obligations.userId, String(user.id)));
  const [existing] = await db.select().from(obligations).where(where).limit(1);
  if (!existing) return Response.json({ error: "Запись не найдена" }, { status: 404 });

  const changes: { currentAmount?: number; status?: "active" | "done" } = {};
  if ("currentAmount" in body) {
    if (existing.kind === "credit" && existing.totalMonths !== null) {
      return Response.json({ error: "Для кредита с графиком сумма обновляется по платежам автоматически" }, { status: 400 });
    }
    const currentAmount = parseNonnegativeAmount(body.currentAmount);
    if (currentAmount === null || currentAmount > existing.amount) {
      return Response.json({ error: "Сумма должна быть от 0 до общей суммы" }, { status: 400 });
    }
    changes.currentAmount = currentAmount;
  }
  if ("status" in body) {
    if (body.status !== "active" && body.status !== "done") {
      return Response.json({ error: "Некорректный статус" }, { status: 400 });
    }
    changes.status = body.status;
  }

  const [updated] = await db.update(obligations).set(changes).where(where).returning();
  return updated ? Response.json(updated) : Response.json({ error: "Запись не найдена" }, { status: 404 });
}

export async function DELETE(request: Request, context: Context) {
  const user = await getApiUser(request);
  if (!user) return unauthorized();
  const id = await recordId(context);
  if (id === null) return Response.json({ error: "Некорректный ID" }, { status: 400 });
  const db = getDb();
  const where = and(eq(obligations.id, id), eq(obligations.userId, String(user.id)));
  const [existing] = await db.select({ id: obligations.id }).from(obligations).where(where).limit(1);
  if (!existing) return Response.json({ error: "Запись не найдена" }, { status: 404 });
  const results = await db.batch([
    db.delete(creditInstallments).where(and(eq(creditInstallments.obligationId, id),
      eq(creditInstallments.userId, String(user.id)), isNull(creditInstallments.postedAt))),
    db.delete(obligations).where(where).returning({ id: obligations.id }),
  ]);
  const deleted = results[1][0];
  return deleted ? new Response(null, { status: 204 })
    : Response.json({ error: "Запись не найдена" }, { status: 404 });
}

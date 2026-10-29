import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { creditInstallments, obligations } from "@/db/schema";
import { getApiUser, unauthorized } from "@/lib/api-user";
import { buildCreditSchedule, hasCreditScheduleFields } from "@/lib/credit-schedule";
import { parseAmount, parseCurrency, parseNonnegativeAmount, parseOptionalDate, parseText, readJsonObject } from "@/lib/validation";

const kinds = new Set(["debt", "goal", "credit"]);

export async function GET(request: Request) {
  const user = await getApiUser(request);
  if (!user) return unauthorized();
  const kind = new URL(request.url).searchParams.get("kind");
  if (kind && !kinds.has(kind)) return Response.json({ error: "Неизвестный тип записи" }, { status: 400 });
  const filter = kind && kinds.has(kind)
    ? and(eq(obligations.userId, String(user.id)), eq(obligations.kind, kind as "debt" | "goal" | "credit"))
    : eq(obligations.userId, String(user.id));
  return Response.json(await getDb().select().from(obligations).where(filter).orderBy(desc(obligations.createdAt)));
}

export async function POST(request: Request) {
  const user = await getApiUser(request);
  if (!user) return unauthorized();
  const body = await readJsonObject(request);
  if (!body) return Response.json({ error: "Некорректный JSON" }, { status: 400 });
  const kind = body.kind ?? "goal";
  const title = parseText(body.title, 80, true);
  const scheduledCredit = kind === "credit" && hasCreditScheduleFields(body)
    ? buildCreditSchedule(body) : null;
  if (kind === "credit" && hasCreditScheduleFields(body) && !scheduledCredit) {
    return Response.json({ error: "Проверьте месячный платёж, срок, оплаченные месяцы и дату следующего платежа (сегодня или позже)" }, { status: 400 });
  }
  const amount = scheduledCredit?.amount ?? parseAmount(body.amount);
  const currentAmount = scheduledCredit?.currentAmount ?? parseNonnegativeAmount(body.currentAmount);
  const currency = parseCurrency(body.currency);
  const dueDate = scheduledCredit?.dueDate ?? parseOptionalDate(body.dueDate);
  if ((kind !== "debt" && kind !== "goal" && kind !== "credit") || !title
    || amount === null || currentAmount === null || currentAmount > amount || !currency || dueDate === undefined) {
    return Response.json({ error: "Проверьте название, суммы, валюту и дату" }, { status: 400 });
  }
  const db = getDb();
  const [created] = await db.insert(obligations).values({
    userId: String(user.id),
    kind,
    title,
    amount,
    currentAmount,
    currency,
    dueDate,
    monthlyPayment: scheduledCredit?.monthlyPayment ?? null,
    totalMonths: scheduledCredit?.totalMonths ?? null,
    paidMonths: scheduledCredit?.paidMonths ?? null,
    paymentDay: scheduledCredit?.paymentDay ?? null,
    nextPaymentDate: scheduledCredit?.nextPaymentDate ?? null,
    createdAt: new Date(),
  }).returning();
  if (scheduledCredit) {
    const timestamp = new Date();
    const rows = scheduledCredit.installments.map((installment) => ({
      obligationId: created.id,
      userId: String(user.id),
      installmentNumber: installment.installmentNumber,
      amount: installment.amount,
      currency,
      dueAt: installment.dueAt,
      createdAt: timestamp,
    }));
    try {
      // Keep each statement under D1's bound-parameter limits. D1 batch is atomic.
      const inserts = Array.from({ length: Math.ceil(rows.length / 10) }, (_, index) =>
        db.insert(creditInstallments).values(rows.slice(index * 10, index * 10 + 10)));
      await db.batch(inserts as [typeof inserts[number], ...typeof inserts[number][]]);
    } catch (error) {
      await db.delete(creditInstallments).where(eq(creditInstallments.obligationId, created.id));
      await db.delete(obligations).where(eq(obligations.id, created.id));
      throw error;
    }
  }
  return Response.json(created, { status: 201 });
}

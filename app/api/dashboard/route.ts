import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { obligations, transactions } from "@/db/schema";
import { getApiUser, unauthorized } from "@/lib/api-user";
import { periodStart } from "@/lib/validation";

const roundMoney = (value: number) => Math.round(value * 100) / 100;

export async function GET(request: Request) {
  const user = await getApiUser(request);
  if (!user) return unauthorized();
  const userId = String(user.id);
  const monthStart = periodStart("month");
  const db = getDb();

  const [totalsByCurrencyRows, recent, categoryRows, active] = await Promise.all([
    db.select({
      currency: transactions.currency,
      income: sql<number>`coalesce(sum(case when ${transactions.type} = 'income' then ${transactions.amount} else 0 end), 0)`,
      expense: sql<number>`coalesce(sum(case when ${transactions.type} = 'expense' then ${transactions.amount} else 0 end), 0)`,
    }).from(transactions).where(and(eq(transactions.userId, userId), gte(transactions.happenedAt, monthStart)))
      .groupBy(transactions.currency),
    db.select().from(transactions).where(eq(transactions.userId, userId)).orderBy(desc(transactions.happenedAt)).limit(8),
    db.select({ category: transactions.category, amount: sql<number>`sum(${transactions.amount})` })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), eq(transactions.type, "expense"),
        eq(transactions.currency, "KZT"), gte(transactions.happenedAt, monthStart)))
      .groupBy(transactions.category)
      .orderBy(desc(sql`sum(${transactions.amount})`))
      .limit(6),
    db.select().from(obligations).where(and(eq(obligations.userId, userId), eq(obligations.status, "active"))).limit(12),
  ]);

  const totalsByCurrency = totalsByCurrencyRows.map((row) => {
    const income = roundMoney(Number(row.income));
    const expense = roundMoney(Number(row.expense));
    return { currency: row.currency, income, expense, balance: roundMoney(income - expense) };
  });
  const totals = totalsByCurrency.find((row) => row.currency === "KZT")
    ?? { currency: "KZT", income: 0, expense: 0, balance: 0 };
  const categories = categoryRows.map((row) => ({ category: row.category, amount: roundMoney(Number(row.amount)) }));
  return Response.json({ user, totals, totalsByCurrency, recent, categories, obligations: active });
}

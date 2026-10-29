import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { transactions } from "@/db/schema";
import { getApiUser, unauthorized } from "@/lib/api-user";
import { localMonth } from "@/lib/validation";

const roundMoney = (value: number) => Math.round(value * 100) / 100;

export async function GET(request: Request) {
  const user = await getApiUser(request);
  if (!user) return unauthorized();
  const period = localMonth(new URL(request.url).searchParams.get("month"));
  if (!period) return Response.json({ error: "Месяц должен быть в формате ГГГГ-ММ" }, { status: 400 });
  const userId = String(user.id);
  const db = getDb();
  const [totalsRows, categoryRows] = await Promise.all([
    db.select({
      currency: transactions.currency,
      income: sql<number>`coalesce(sum(case when ${transactions.type} = 'income' then ${transactions.amount} else 0 end), 0)`,
      expense: sql<number>`coalesce(sum(case when ${transactions.type} = 'expense' then ${transactions.amount} else 0 end), 0)`,
    }).from(transactions).where(and(eq(transactions.userId, userId),
      gte(transactions.happenedAt, period.start), lt(transactions.happenedAt, period.end)))
      .groupBy(transactions.currency),
    db.select({ category: transactions.category, amount: sql<number>`sum(${transactions.amount})` })
      .from(transactions).where(and(eq(transactions.userId, userId),
        eq(transactions.type, "expense"), eq(transactions.currency, "KZT"),
        gte(transactions.happenedAt, period.start), lt(transactions.happenedAt, period.end)))
      .groupBy(transactions.category).orderBy(desc(sql`sum(${transactions.amount})`)).limit(20),
  ]);
  const totalsByCurrency = totalsRows.map((row) => {
    const income = roundMoney(Number(row.income));
    const expense = roundMoney(Number(row.expense));
    return { currency: row.currency, income, expense, balance: roundMoney(income - expense) };
  });
  const totals = totalsByCurrency.find((row) => row.currency === "KZT")
    ?? { currency: "KZT", income: 0, expense: 0, balance: 0 };
  const categories = categoryRows.map((row) => ({
    category: row.category, amount: roundMoney(Number(row.amount)),
  }));
  return Response.json({ month: period.month, totals, totalsByCurrency, categories });
}

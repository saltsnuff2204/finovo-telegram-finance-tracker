import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { categories, transactions, users } from "@/db/schema";
import { getApiUser, unauthorized } from "@/lib/api-user";
import { parseAmount, parseCurrency, parseOptionalDate, parseText, readJsonObject } from "@/lib/validation";

export async function GET(request: Request) {
  const user = await getApiUser(request);
  if (!user) return unauthorized();
  const rows = await getDb()
    .select()
    .from(transactions)
    .where(eq(transactions.userId, String(user.id)))
    .orderBy(desc(transactions.happenedAt))
    .limit(100);
  return Response.json(rows);
}

export async function POST(request: Request) {
  const user = await getApiUser(request);
  if (!user) return unauthorized();
  const body = await readJsonObject(request);
  if (!body) return Response.json({ error: "Некорректный JSON" }, { status: 400 });
  const type = body.type ?? "expense";
  const amount = parseAmount(body.amount);
  const currency = parseCurrency(body.currency);
  const category = parseText(body.category ?? (type === "income" ? "Доход" : "Другое"), 40, true);
  const note = parseText(body.note ?? "", 160);
  const happenedAt = parseOptionalDate(body.happenedAt);
  const saveCategoryPreset = body.saveCategoryPreset === true || body.saveCategoryPreset === "on";
  if ((type !== "income" && type !== "expense") || amount === null || !currency
    || category === null || note === null || happenedAt === undefined
    || (body.saveCategoryPreset !== undefined && body.saveCategoryPreset !== true
      && body.saveCategoryPreset !== false && body.saveCategoryPreset !== "on")) {
    return Response.json({ error: "Проверьте тип, сумму, валюту и дату операции" }, { status: 400 });
  }

  const db = getDb();
  let presetNeeded = saveCategoryPreset;
  if (saveCategoryPreset) {
    const presets = await db.select({ name: categories.name, type: categories.type }).from(categories)
      .where(eq(categories.userId, String(user.id)));
    presetNeeded = !presets.some((row) => row.type === type
      && row.name.toLocaleLowerCase("ru") === category.toLocaleLowerCase("ru"));
    if (presetNeeded && presets.length >= 100) {
      return Response.json({ error: "Можно сохранить не больше 100 категорий" }, { status: 400 });
    }
  }
  const upsertUser = db.insert(users).values({
    id: String(user.id),
    firstName: user.first_name,
    username: user.username ?? null,
    createdAt: new Date(),
  }).onConflictDoNothing();
  const createTransaction = db.insert(transactions).values({
    userId: String(user.id),
    type,
    amount,
    currency,
    category,
    note,
    happenedAt: happenedAt ?? new Date(),
    createdAt: new Date(),
  }).returning();
  let created: typeof transactions.$inferSelect;
  if (presetNeeded) {
    const results = await db.batch([
      upsertUser,
      createTransaction,
      db.insert(categories).values({ userId: String(user.id), name: category, type })
        .onConflictDoNothing({ target: [categories.userId, categories.type, categories.name] }),
    ]);
    created = results[1][0];
  } else {
    await upsertUser;
    [created] = await createTransaction;
  }
  return Response.json(created, { status: 201 });
}

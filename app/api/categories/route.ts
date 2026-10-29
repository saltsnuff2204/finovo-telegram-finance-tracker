import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { categories } from "@/db/schema";
import { getApiUser, unauthorized } from "@/lib/api-user";
import { parseText, readJsonObject } from "@/lib/validation";

function categoryType(value: unknown): "income" | "expense" | null {
  return value === "income" || value === "expense" ? value : null;
}

export async function GET(request: Request) {
  const user = await getApiUser(request);
  if (!user) return unauthorized();
  const rows = await getDb().select().from(categories)
    .where(eq(categories.userId, String(user.id)))
    .orderBy(asc(categories.type), asc(categories.name));
  return Response.json(rows);
}

export async function POST(request: Request) {
  const user = await getApiUser(request);
  if (!user) return unauthorized();
  const body = await readJsonObject(request);
  if (!body) return Response.json({ error: "Некорректный JSON" }, { status: 400 });
  const name = parseText(body.name, 40, true);
  const type = categoryType(body.type ?? "expense");
  if (!name || !type) return Response.json({ error: "Укажите название категории и тип" }, { status: 400 });
  const userId = String(user.id);
  const db = getDb();
  const allRows = await db.select().from(categories).where(eq(categories.userId, userId));
  const existing = allRows.find((row) => row.type === type
    && row.name.toLocaleLowerCase("ru") === name.toLocaleLowerCase("ru"));
  if (existing) return Response.json(existing);
  if (allRows.length >= 100) {
    return Response.json({ error: "Можно сохранить не больше 100 категорий" }, { status: 400 });
  }
  const [created] = await db.insert(categories).values({ userId, name, type })
    .onConflictDoNothing({ target: [categories.userId, categories.type, categories.name] }).returning();
  if (created) return Response.json(created, { status: 201 });
  const [duplicate] = await db.select().from(categories).where(and(
    eq(categories.userId, userId), eq(categories.type, type), eq(categories.name, name),
  )).limit(1);
  return duplicate ? Response.json(duplicate) : Response.json({ error: "Не удалось сохранить категорию" }, { status: 409 });
}

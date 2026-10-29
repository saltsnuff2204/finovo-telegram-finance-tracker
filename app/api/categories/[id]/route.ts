import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { categories } from "@/db/schema";
import { getApiUser, unauthorized } from "@/lib/api-user";
import { parseText, readJsonObject } from "@/lib/validation";

type Context = { params: Promise<{ id: string }> };

async function categoryId(context: Context) {
  const { id } = await context.params;
  return /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)) ? Number(id) : null;
}

export async function PATCH(request: Request, context: Context) {
  const user = await getApiUser(request);
  if (!user) return unauthorized();
  const id = await categoryId(context);
  if (id === null) return Response.json({ error: "Некорректный ID" }, { status: 400 });
  const body = await readJsonObject(request);
  if (!body) return Response.json({ error: "Некорректный JSON" }, { status: 400 });
  const name = parseText(body.name, 40, true);
  if (!name) return Response.json({ error: "Укажите название категории" }, { status: 400 });
  const db = getDb();
  const where = and(eq(categories.id, id), eq(categories.userId, String(user.id)));
  const [existing] = await db.select().from(categories).where(where).limit(1);
  if (!existing) return Response.json({ error: "Категория не найдена" }, { status: 404 });
  const existingNames = await db.select({ id: categories.id, name: categories.name }).from(categories)
    .where(and(eq(categories.userId, String(user.id)), eq(categories.type, existing.type)));
  if (existingNames.some((row) => row.id !== id && row.name.toLowerCase() === name.toLowerCase())) {
    return Response.json({ error: "Такая категория уже есть" }, { status: 409 });
  }
  const [updated] = await db.update(categories).set({ name }).where(where).returning();
  return Response.json(updated);
}

export async function DELETE(request: Request, context: Context) {
  const user = await getApiUser(request);
  if (!user) return unauthorized();
  const id = await categoryId(context);
  if (id === null) return Response.json({ error: "Некорректный ID" }, { status: 400 });
  const [deleted] = await getDb().delete(categories)
    .where(and(eq(categories.id, id), eq(categories.userId, String(user.id))))
    .returning({ id: categories.id });
  return deleted ? new Response(null, { status: 204 })
    : Response.json({ error: "Категория не найдена" }, { status: 404 });
}

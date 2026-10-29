import { userFromRequest, type TelegramUser } from "./telegram-auth";

export async function getApiUser(request: Request): Promise<TelegramUser | null> {
  const user = await userFromRequest(request);
  if (user) return user;

  const hostname = new URL(request.url).hostname;
  if (import.meta.env.DEV && (hostname === "localhost" || hostname === "127.0.0.1")
    && request.headers.get("x-demo-user") === "1") {
    return { id: 1, first_name: "Демо" };
  }
  return null;
}

export function unauthorized() {
  return Response.json({ error: "Откройте приложение внутри Telegram" }, { status: 401 });
}

import { env } from "cloudflare:workers";

function appButton() {
  if (!env.MINI_APP_URL) return {};
  try {
    const url = new URL(env.MINI_APP_URL);
    if (url.protocol !== "https:") return {};
    return { reply_markup: { inline_keyboard: [[{ text: "Открыть финансы", web_app: { url: url.href } }]] } };
  } catch {
    return {};
  }
}

export async function sendTelegramMessage(chatId: number, message: string, withAppButton = false) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: message, ...(withAppButton ? appButton() : {}) }),
  });
  if (!response.ok) throw new Error(`Telegram sendMessage failed with HTTP ${response.status}`);
  const result = await response.json() as { ok?: boolean };
  if (!result.ok) throw new Error("Telegram sendMessage was rejected");
}

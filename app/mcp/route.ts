import { env } from "cloudflare:workers";
import { processCreditSchedule } from "@/lib/credit-processor";

type RpcRequest = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

const tool = {
  name: "run_credit_schedule",
  title: "Обработать платежи и напоминания по кредитам",
  description: "Owner-only scheduled maintenance: record due credit payments and send Telegram reminders for installments due in 7, 3 or 1 day. Safe to retry; never provide credentials or personal data in arguments.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

function rpc(id: unknown, result: unknown) {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function rpcError(id: unknown, code: number, message: string, status = 400) {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status });
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return new Response("Forbidden origin", { status: 403 });
  }
  const raw = await request.text();
  if (raw.length > 32_768) return new Response("Payload too large", { status: 413 });
  let message: RpcRequest;
  try {
    message = JSON.parse(raw) as RpcRequest;
  } catch {
    return rpcError(null, -32700, "Parse error");
  }
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(message?.id, -32600, "Invalid request");
  }
  if (!("id" in message)) return new Response(null, { status: 202 });

  switch (message.method) {
    case "initialize": {
      const params = message.params as { protocolVersion?: unknown } | null;
      const requested = params?.protocolVersion;
      const version = requested === "2025-03-26" ? "2025-03-26" : "2025-06-18";
      return rpc(message.id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: "finovo-credit-scheduler", version: "1.0.0" },
      });
    }
    case "ping": return rpc(message.id, {});
    case "tools/list": return rpc(message.id, { tools: [tool] });
    case "tools/call": {
      const params = message.params as { name?: unknown; arguments?: unknown } | null;
      if (params?.name !== tool.name) return rpcError(message.id, -32602, "Unknown tool");
      if (!env.MCP_OWNER_ID || request.headers.get("oai-authenticated-user-id") !== env.MCP_OWNER_ID
        || !request.headers.get("oai-authenticated-user-email")) {
        return rpcError(message.id, -32001, "Owner authorization required", 403);
      }
      try {
        const result = await processCreditSchedule();
        return rpc(message.id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
          isError: result.reminderFailures > 0 || result.moreDue || result.moreUpcoming,
        });
      } catch (error) {
        console.error("Credit schedule failed", error instanceof Error ? error.message : "unknown error");
        return rpc(message.id, {
          content: [{ type: "text", text: "Не удалось обработать график кредитов. Повторите запуск позже." }],
          isError: true,
        });
      }
    }
    default: return rpcError(message.id, -32601, "Method not found");
  }
}

export function GET() {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}

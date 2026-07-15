import type { IncomingMessage, ServerResponse } from "node:http";
import {
  dashboardMetrics,
  getMessage,
  getRecommendation,
  listMessages,
  listPendingDrafts,
  searchRag,
} from "@indeedee/db";
import { processMessage } from "@indeedee/brain";
import { runSync, sendApprovedDraft } from "../services/runtime.js";
import { createTaskFromMessage } from "@indeedee/asana";

type Ctx = { ownerId: string; role: "owner" | "viewer" };

export async function handleMcpHttp(
  method: string,
  path: string,
  body: string,
  ctx: Ctx,
): Promise<{ status: number; body: string; contentType: string }> {
  if (method === "GET" && (path === "/mcp/healthz" || path === "/mcp/health")) {
    return { status: 200, body: JSON.stringify({ ok: true }), contentType: "application/json" };
  }
  if (method !== "POST" || path !== "/mcp/tools/call") {
    return { status: 404, body: "Not found", contentType: "text/plain" };
  }
  const payload = JSON.parse(body || "{}") as {
    tool: string;
    arguments?: Record<string, unknown>;
  };
  try {
    const result = await dispatchTool(ctx, payload.tool, payload.arguments ?? {});
    return { status: 200, body: JSON.stringify({ result }), contentType: "application/json" };
  } catch (err) {
    return {
      status: 400,
      body: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      contentType: "application/json",
    };
  }
}

export async function handleMcpRequest(req: IncomingMessage, res: ServerResponse, ctx: Ctx) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  const path = req.url?.split("?")[0] ?? "/mcp";
  const result = await handleMcpHttp(req.method ?? "GET", path, body, ctx);
  res.writeHead(result.status, { "content-type": result.contentType });
  res.end(result.body);
}

async function dispatchTool(ctx: Ctx, tool: string, args: Record<string, unknown>) {
  switch (tool) {
    case "retrieve_context":
      return searchRag(ctx.ownerId, String(args.query ?? ""), Number(args.topK ?? 5));
    case "list_pending":
      return listMessages(ctx.ownerId, { pendingOnly: true });
    case "dashboard_stats":
      return dashboardMetrics(ctx.ownerId);
    case "recommend_and_draft": {
      const msg = await getMessage(ctx.ownerId, String(args.messageId));
      if (!msg) throw new Error("Message not found");
      return processMessage(ctx.ownerId, msg);
    }
    case "approve_and_send": {
      if (ctx.role !== "owner") throw new Error("Owner role required");
      return sendApprovedDraft(ctx.ownerId, String(args.draftId), args.editedBody as string | undefined);
    }
    case "create_asana_task":
      return createTaskFromMessage({
        pat: process.env.ASANA_PAT ?? "demo",
        title: String(args.title),
        notes: String(args.notes ?? ""),
        dueOn: args.dueOn as string | undefined,
      });
    case "sync":
      if (ctx.role !== "owner") throw new Error("Owner role required");
      return runSync(ctx.ownerId);
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

export const MCP_TOOLS = [
  "retrieve_context",
  "list_pending",
  "dashboard_stats",
  "recommend_and_draft",
  "approve_and_send",
  "create_asana_task",
  "sync",
] as const;

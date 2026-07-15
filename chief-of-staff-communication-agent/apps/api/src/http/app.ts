import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { appRouter } from "../trpc/router.js";
import { handleMcpHttp } from "../mcp/server.js";
import {
  googleOAuthExchange,
  googleOAuthStartUrl,
  isGoogleOAuthConfigured,
  persistGoogleConnection,
  verifyOAuthState,
} from "../oauth/google.js";
import { publicUser, resolveAuthContext } from "../auth/context.js";
import {
  googleSsoExchange,
  googleSsoStartUrl,
  isSsoEnabled,
  sessionFromGoogleProfile,
  verifyLoginState,
} from "../auth/google-sso.js";
import { readSessionCookie, sessionClearCookieHeader, sessionSetCookieHeader } from "../auth/session.js";
import type { HttpRequest, HttpResponse } from "./types.js";
import { jsonResponse, redirectResponse, textResponse } from "./types.js";

export interface HandleHttpOptions {
  serveWeb?: boolean;
  webRoot?: string;
}

function reqLike(req: HttpRequest): import("node:http").IncomingMessage {
  return { headers: req.headers } as import("node:http").IncomingMessage;
}

function apiContext(req: HttpRequest, trustHeaders = false) {
  const auth = resolveAuthContext(reqLike(req), { trustHeaders });
  return { ownerId: auth.ownerId, role: auth.role };
}

function requireAuth(req: HttpRequest): ReturnType<typeof resolveAuthContext> | HttpResponse | null {
  const auth = resolveAuthContext(reqLike(req));
  if (isSsoEnabled() && !auth.user) {
    return jsonResponse(401, { error: "Sign in required" });
  }
  return auth;
}

export async function handleHttpRequest(
  req: HttpRequest,
  opts: HandleHttpOptions = {},
): Promise<HttpResponse> {
  const origin = req.baseUrl;

  if (req.method === "GET" && req.path === "/health") {
    return jsonResponse(200, { ok: true, service: "indeedee-agent" });
  }

  if (req.method === "GET" && req.path === "/api/auth/config") {
    const auth = resolveAuthContext(reqLike(req));
    return jsonResponse(200, {
      ssoEnabled: isSsoEnabled(),
      devMode: auth.devMode,
      user: publicUser(auth.user),
    });
  }
  if (req.method === "GET" && req.path === "/api/auth/me") {
    const auth = resolveAuthContext(reqLike(req));
    if (!auth.user) return jsonResponse(401, { error: "Not signed in" });
    return jsonResponse(200, { user: publicUser(auth.user) });
  }
  if (req.method === "GET" && req.path === "/api/auth/google/start") {
    if (!isSsoEnabled()) return jsonResponse(503, { error: "SSO is not configured" });
    const returnTo = req.query.returnTo ?? "/";
    return jsonResponse(200, { url: googleSsoStartUrl(origin, returnTo) });
  }
  if (req.method === "GET" && req.path === "/api/auth/google/callback") {
    const code = req.query.code;
    const state = req.query.state;
    const err = req.query.error;
    if (err) return redirectResponse(`${origin}/?error=${encodeURIComponent(String(err))}`);
    const returnTo = state ? verifyLoginState(String(state)) : null;
    if (!code || !returnTo) return redirectResponse(`${origin}/?error=invalid_login_state`);
    try {
      const profile = await googleSsoExchange(String(code), origin);
      const { token } = sessionFromGoogleProfile(profile);
      return redirectResponse(`${origin}${returnTo}`, {
        "Set-Cookie": sessionSetCookieHeader(token),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return redirectResponse(`${origin}/?error=${encodeURIComponent(msg)}`);
    }
  }
  if (req.method === "POST" && req.path === "/api/auth/logout") {
    return jsonResponse(200, { ok: true }, { "Set-Cookie": sessionClearCookieHeader() });
  }

  if (req.path.startsWith("/mcp")) {
    const mcpCtx = apiContext(req, true);
    if (isSsoEnabled() && !readSessionCookie(reqLike(req)) && !req.headers["x-owner-id"]) {
      return jsonResponse(401, { error: "Sign in required" });
    }
    const mcp = await handleMcpHttp(req.method, req.path, req.body ?? "", mcpCtx);
    return {
      status: mcp.status,
      headers: { "content-type": mcp.contentType },
      body: mcp.body,
    };
  }

  if (opts.serveWeb && req.method === "GET" && (req.path === "/" || req.path === "/index.html")) {
    const webRoot = opts.webRoot ?? join(process.cwd(), "apps/web/public");
    const webPath = join(webRoot, "index.html");
    if (existsSync(webPath)) {
      return textResponse(200, readFileSync(webPath, "utf8"), "text/html");
    }
  }

  const authResult = requireAuth(req);
  if (!authResult || "status" in authResult) {
    return authResult ?? jsonResponse(401, { error: "Sign in required" });
  }
  const ctx = apiContext(req);
  const caller = appRouter.createCaller(ctx);

  try {
    if (req.method === "GET" && req.path === "/api/dashboard") {
      return jsonResponse(200, await caller.metrics.dashboard());
    }
    if (req.method === "GET" && req.path === "/api/inbox") {
      return jsonResponse(200, await caller.communications.list());
    }
    if (req.method === "GET" && req.path.startsWith("/api/messages/")) {
      const id = req.path.split("/").pop()!;
      return jsonResponse(200, await caller.communications.get({ messageId: id }));
    }
    if (req.method === "GET" && req.path === "/api/approvals") {
      return jsonResponse(200, await caller.approvals.list());
    }
    if (req.method === "GET" && req.path === "/api/connections") {
      return jsonResponse(200, await caller.connectors.list());
    }
    if (req.method === "GET" && req.path === "/api/connections/catalog") {
      return jsonResponse(200, await caller.connectors.catalog());
    }
    if (req.method === "GET" && req.path === "/api/oauth/google/start") {
      if (ctx.role !== "owner") return jsonResponse(403, { error: "Owner required" });
      if (!isGoogleOAuthConfigured()) {
        return jsonResponse(503, { error: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in server env" });
      }
      return jsonResponse(200, { url: googleOAuthStartUrl(ctx.ownerId, origin) });
    }
    if (req.method === "GET" && req.path === "/api/oauth/google/callback") {
      const code = req.query.code;
      const state = req.query.state;
      const err = req.query.error;
      if (err) {
        return redirectResponse(`${origin}/?tab=connections&error=${encodeURIComponent(String(err))}`);
      }
      const ownerId = state ? verifyOAuthState(String(state)) : null;
      if (!code || !ownerId) {
        return redirectResponse(`${origin}/?tab=connections&error=invalid_oauth_state`);
      }
      try {
        const tokens = await googleOAuthExchange(String(code), origin);
        await persistGoogleConnection(ownerId, tokens);
        return redirectResponse(`${origin}/?tab=connections&connected=gmail`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return redirectResponse(`${origin}/?tab=connections&error=${encodeURIComponent(msg)}`);
      }
    }
    if (req.method === "GET" && req.path === "/api/knowledge") {
      return jsonResponse(200, await caller.knowledge.list());
    }
    if (req.method === "GET" && req.path === "/api/people") {
      return jsonResponse(200, await caller.people.list());
    }
    if (req.method === "GET" && req.path.startsWith("/api/people/")) {
      const handle = decodeURIComponent(req.path.slice("/api/people/".length));
      return jsonResponse(200, await caller.people.thread({ handle }));
    }
    if (req.method === "POST" && req.path === "/api/seed-demo") {
      if (ctx.role !== "owner") return jsonResponse(403, { error: "Owner required" });
      return jsonResponse(200, await caller.connectors.seedDemo());
    }
    if (req.method === "POST" && req.path === "/api/sync") {
      if (ctx.role !== "owner") return jsonResponse(403, { error: "Owner required" });
      return jsonResponse(200, await caller.sync());
    }
    if (req.method === "POST" && req.path === "/api/approve") {
      if (ctx.role !== "owner") return jsonResponse(403, { error: "Owner required" });
      return jsonResponse(200, await caller.approvals.approve(JSON.parse(req.body ?? "{}")));
    }
    if (req.method === "POST" && req.path === "/api/reject") {
      if (ctx.role !== "owner") return jsonResponse(403, { error: "Owner required" });
      return jsonResponse(200, await caller.approvals.reject(JSON.parse(req.body ?? "{}")));
    }
    if (req.method === "POST" && req.path === "/api/knowledge") {
      if (ctx.role !== "owner") return jsonResponse(403, { error: "Owner required" });
      return jsonResponse(200, await caller.knowledge.add(JSON.parse(req.body ?? "{}")));
    }
    if (req.method === "POST" && req.path === "/api/context") {
      if (ctx.role !== "owner") return jsonResponse(403, { error: "Owner required" });
      return jsonResponse(200, await caller.approvals.provideContext(JSON.parse(req.body ?? "{}")));
    }
    if (req.method === "POST" && req.path === "/api/connect") {
      if (ctx.role !== "owner") return jsonResponse(403, { error: "Owner required" });
      return jsonResponse(200, await caller.connectors.connect(JSON.parse(req.body ?? "{}")));
    }
    if (req.method === "POST" && req.path === "/api/connect/form") {
      if (ctx.role !== "owner") return jsonResponse(403, { error: "Owner required" });
      return jsonResponse(200, await caller.connectors.connectForm(JSON.parse(req.body ?? "{}")));
    }
    if (req.method === "POST" && req.path === "/api/connect/test") {
      if (ctx.role !== "owner") return jsonResponse(403, { error: "Owner required" });
      return jsonResponse(200, await caller.connectors.test(JSON.parse(req.body ?? "{}")));
    }
    if (req.method === "DELETE" && req.path.startsWith("/api/connect/")) {
      if (ctx.role !== "owner") return jsonResponse(403, { error: "Owner required" });
      const parts = req.path.split("/").filter(Boolean);
      const channel = parts[2];
      const accountHandle = decodeURIComponent(parts.slice(3).join("/") || "");
      if (channel === "asana") {
        return jsonResponse(200, await caller.connectors.disconnectAsana());
      }
      const allowed = ["gmail", "email", "sms", "whatsapp", "x"] as const;
      if (!channel || !allowed.includes(channel as (typeof allowed)[number])) {
        return jsonResponse(400, { error: "Invalid channel" });
      }
      return jsonResponse(
        200,
        await caller.connectors.disconnect({
          channel: channel as (typeof allowed)[number],
          accountHandle,
        }),
      );
    }
    if (req.method === "POST" && req.path === "/api/rag/search") {
      return jsonResponse(200, await caller.rag.search(JSON.parse(req.body ?? "{}")));
    }
  } catch (err) {
    return jsonResponse(500, { error: err instanceof Error ? err.message : String(err) });
  }

  return textResponse(404, "Not found");
}

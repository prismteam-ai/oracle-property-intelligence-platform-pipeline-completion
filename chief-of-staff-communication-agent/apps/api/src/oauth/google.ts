import { createHmac, timingSafeEqual } from "node:crypto";
import { upsertConnectorToken } from "@indeedee/db";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "openid",
  "email",
].join(" ");

function oauthSecret(): string {
  return process.env.OAUTH_STATE_SECRET ?? process.env.GOOGLE_CLIENT_SECRET ?? "indeedee-dev-secret";
}

export function signOAuthState(ownerId: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", oauthSecret())
    .update(`${ts}:${ownerId}`)
    .digest("hex")
    .slice(0, 20);
  return Buffer.from(`${ownerId}:${ts}:${sig}`).toString("base64url");
}

export function verifyOAuthState(state: string): string | null {
  try {
    const raw = Buffer.from(state, "base64url").toString("utf8");
    const [ownerId, tsStr, sig] = raw.split(":");
    if (!ownerId || !tsStr || !sig) return null;
    const ts = Number(tsStr);
    if (!Number.isFinite(ts) || Date.now() / 1000 - ts > 600) return null;
    const expect = createHmac("sha256", oauthSecret())
      .update(`${ts}:${ownerId}`)
      .digest("hex")
      .slice(0, 20);
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return ownerId;
  } catch {
    return null;
  }
}

export function isGoogleOAuthConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function googleOAuthStartUrl(ownerId: string, origin: string): string {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID is not configured");
  const redirectUri =
    process.env.GOOGLE_OAUTH_REDIRECT_URI ?? `${origin.replace(/\/$/, "")}/api/oauth/google/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state: signOAuthState(ownerId),
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export async function googleOAuthExchange(code: string, origin: string): Promise<{
  refreshToken: string;
  accessToken: string;
  email: string;
}> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Google OAuth is not configured");
  const redirectUri =
    process.env.GOOGLE_OAUTH_REDIRECT_URI ?? `${origin.replace(/\/$/, "")}/api/oauth/google/callback`;

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Google token exchange failed: ${await tokenRes.text()}`);
  }
  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
  };
  if (!tokens.refresh_token) {
    throw new Error("Google did not return a refresh token — revoke app access and retry with prompt=consent");
  }

  const profileRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!profileRes.ok) throw new Error("Failed to fetch Google profile");
  const profile = (await profileRes.json()) as { email?: string };
  const email = profile.email ?? "gmail@connected.local";

  return {
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    email,
  };
}

export async function persistGoogleConnection(ownerId: string, tokens: Awaited<ReturnType<typeof googleOAuthExchange>>) {
  await upsertConnectorToken({
    ownerId,
    channel: "gmail",
    accountHandle: tokens.email,
    credentials: {
      mode: "live",
      refreshToken: tokens.refreshToken,
      accessToken: tokens.accessToken,
    },
  });
}

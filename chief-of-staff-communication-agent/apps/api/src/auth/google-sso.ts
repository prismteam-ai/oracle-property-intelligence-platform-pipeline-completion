import { createHmac, timingSafeEqual } from "node:crypto";
import { ownerIdFromEmail, roleForEmail, signSession, type SessionUser } from "./session.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SSO_SCOPES = ["openid", "email", "profile"].join(" ");

function oauthSecret(): string {
  return process.env.OAUTH_STATE_SECRET ?? process.env.GOOGLE_CLIENT_SECRET ?? "indeedee-dev-secret";
}

export function isGoogleSsoConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function isSsoEnabled(): boolean {
  if (process.env.INDEEDEE_SSO_ENABLED === "false") return false;
  if (process.env.INDEEDEE_SSO_ENABLED === "true") return isGoogleSsoConfigured();
  return isGoogleSsoConfigured();
}

function ssoRedirectUri(origin: string): string {
  return (
    process.env.GOOGLE_SSO_REDIRECT_URI ??
    `${origin.replace(/\/$/, "")}/api/auth/google/callback`
  );
}

export function signLoginState(returnTo: string): string {
  const safeReturn = returnTo.startsWith("/") ? returnTo : "/";
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", oauthSecret())
    .update(`${ts}:login:${safeReturn}`)
    .digest("hex")
    .slice(0, 20);
  return Buffer.from(`login:${safeReturn}:${ts}:${sig}`).toString("base64url");
}

export function verifyLoginState(state: string): string | null {
  try {
    const raw = Buffer.from(state, "base64url").toString("utf8");
    const [kind, returnTo, tsStr, sig] = raw.split(":");
    if (kind !== "login" || !returnTo || !tsStr || !sig) return null;
    const ts = Number(tsStr);
    if (!Number.isFinite(ts) || Date.now() / 1000 - ts > 600) return null;
    const expect = createHmac("sha256", oauthSecret())
      .update(`${ts}:login:${returnTo}`)
      .digest("hex")
      .slice(0, 20);
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return returnTo.startsWith("/") ? returnTo : "/";
  } catch {
    return null;
  }
}

export function googleSsoStartUrl(origin: string, returnTo = "/"): string {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID is not configured");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: ssoRedirectUri(origin),
    response_type: "code",
    scope: SSO_SCOPES,
    access_type: "online",
    prompt: "select_account",
    state: signLoginState(returnTo),
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export async function googleSsoExchange(
  code: string,
  origin: string,
): Promise<{ email: string; name?: string; sub: string }> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Google SSO is not configured");

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: ssoRedirectUri(origin),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Google SSO token exchange failed: ${await tokenRes.text()}`);
  }
  const tokens = (await tokenRes.json()) as { access_token: string };

  const profileRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!profileRes.ok) throw new Error("Failed to fetch Google profile");
  const profile = (await profileRes.json()) as {
    email?: string;
    name?: string;
    id?: string;
  };
  if (!profile.email) throw new Error("Google account has no email");
  return { email: profile.email, name: profile.name, sub: profile.id ?? profile.email };
}

export function sessionFromGoogleProfile(profile: {
  email: string;
  name?: string;
}): { token: string; user: SessionUser } {
  const user: SessionUser = {
    ownerId: ownerIdFromEmail(profile.email),
    email: profile.email,
    name: profile.name,
    role: roleForEmail(profile.email),
  };
  return { token: signSession(user), user };
}

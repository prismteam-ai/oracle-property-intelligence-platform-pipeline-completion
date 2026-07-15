import { createHmac, timingSafeEqual } from "node:crypto";

export interface SessionUser {
  ownerId: string;
  email: string;
  name?: string;
  role: "owner" | "viewer";
}

const SESSION_COOKIE = "indeedee_session";
const SESSION_TTL_SEC = 7 * 24 * 60 * 60;

function sessionSecret(): string {
  return (
    process.env.INDEEDEE_SESSION_SECRET ??
    process.env.OAUTH_STATE_SECRET ??
    process.env.GOOGLE_CLIENT_SECRET ??
    "indeedee-dev-session-secret"
  );
}

export function ownerIdFromEmail(email: string): string {
  const slug = email
    .toLowerCase()
    .replace(/@.+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, 64) || "user";
}

export function roleForEmail(email: string): "owner" | "viewer" {
  const raw = process.env.INDEEDEE_OWNER_EMAILS?.trim();
  if (!raw) return "owner";
  const owners = raw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return owners.includes(email.toLowerCase()) ? "owner" : "viewer";
}

export function signSession(user: Omit<SessionUser, "role"> & { role?: SessionUser["role"] }): string {
  const payload = {
    ownerId: user.ownerId,
    email: user.email,
    name: user.name,
    role: user.role ?? roleForEmail(user.email),
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifySession(token: string | undefined | null): SessionUser | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expect = createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionUser & {
      exp: number;
    };
    if (!payload.email || !payload.ownerId || !payload.exp) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return {
      ownerId: payload.ownerId,
      email: payload.email,
      name: payload.name,
      role: payload.role === "viewer" ? "viewer" : "owner",
    };
  } catch {
    return null;
  }
}

export function parseCookies(header?: string | string[]): Record<string, string> {
  const raw = Array.isArray(header) ? header.join(";") : header;
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq)] = decodeURIComponent(trimmed.slice(eq + 1));
  }
  return out;
}

export function readSessionCookie(req: { headers: Record<string, string | string[] | undefined> }): SessionUser | null {
  const cookies = parseCookies(req.headers.cookie);
  return verifySession(cookies[SESSION_COOKIE]);
}

export function sessionSetCookieHeader(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SEC}${secure}`;
}

export function sessionClearCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export { SESSION_COOKIE };

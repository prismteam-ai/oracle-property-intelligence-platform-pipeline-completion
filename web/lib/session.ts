import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

const COOKIE = "oracle_session";

function secret(): Uint8Array {
  const s = process.env.AUTH_JWT_SECRET ?? "dev-insecure-change-me-0123456789";
  return new TextEncoder().encode(s);
}

export type Session = { username: string; role: "owner" | "viewer" };

export async function signToken(session: Session): Promise<string> {
  return new SignJWT({ role: session.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(session.username)
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(secret());
}

export async function verifyToken(token: string): Promise<Session | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    return {
      username: String(payload.sub),
      role: (payload.role as "owner" | "viewer") ?? "viewer",
    };
  } catch {
    return null;
  }
}

export async function setSessionCookie(token: string) {
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    // Secure cookies require HTTPS. Default on in production, but allow an
    // explicit override (COOKIE_SECURE=false) for a local HTTP Docker run.
    secure: process.env.COOKIE_SECURE
      ? process.env.COOKIE_SECURE === "true"
      : process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(COOKIE);
}

export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  return token ? verifyToken(token) : null;
}

export const SESSION_COOKIE = COOKIE;

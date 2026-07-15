import type { IncomingMessage } from "node:http";
import { isSsoEnabled } from "./google-sso.js";
import { readSessionCookie, type SessionUser } from "./session.js";

export interface AuthContext {
  ownerId: string;
  role: "owner" | "viewer";
  user: SessionUser | null;
  devMode: boolean;
}

export function resolveAuthContext(
  req: IncomingMessage,
  opts?: { trustHeaders?: boolean },
): AuthContext {
  const sessionUser = readSessionCookie(req);
  if (sessionUser) {
    return {
      ownerId: sessionUser.ownerId,
      role: sessionUser.role,
      user: sessionUser,
      devMode: false,
    };
  }

  const sso = isSsoEnabled();
  const headerOwner = req.headers["x-owner-id"]?.toString();
  const headerRole = req.headers["x-role"]?.toString();

  if (headerOwner && (!sso || opts?.trustHeaders)) {
    return {
      ownerId: headerOwner,
      role: headerRole === "viewer" ? "viewer" : "owner",
      user: null,
      devMode: !sso,
    };
  }

  if (sso) {
    return { ownerId: "anonymous", role: "viewer", user: null, devMode: false };
  }

  return {
    ownerId: headerOwner ?? "demo-owner",
    role: headerRole === "viewer" ? "viewer" : "owner",
    user: null,
    devMode: true,
  };
}

export function publicUser(user: SessionUser | null) {
  if (!user) return null;
  return {
    ownerId: user.ownerId,
    email: user.email,
    name: user.name,
    role: user.role,
  };
}

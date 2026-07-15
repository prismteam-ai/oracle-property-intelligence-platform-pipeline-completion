import { describe, expect, it, afterEach } from "vitest";
import {
  ownerIdFromEmail,
  roleForEmail,
  signSession,
  verifySession,
  sessionSetCookieHeader,
} from "../../apps/api/src/auth/session.js";
import { resolveAuthContext } from "../../apps/api/src/auth/context.js";
import {
  isSsoEnabled,
  signLoginState,
  verifyLoginState,
  sessionFromGoogleProfile,
} from "../../apps/api/src/auth/google-sso.js";

describe("Google SSO session", () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it("signs and verifies session tokens", () => {
    process.env.INDEEDEE_SESSION_SECRET = "test-session-secret";
    const token = signSession({
      ownerId: "jane",
      email: "jane@company.com",
      name: "Jane",
      role: "owner",
    });
    const user = verifySession(token);
    expect(user?.email).toBe("jane@company.com");
    expect(user?.ownerId).toBe("jane");
    expect(user?.role).toBe("owner");
  });

  it("derives owner id slug from email", () => {
    expect(ownerIdFromEmail("Jane.Doe@Company.com")).toBe("jane-doe");
  });

  it("assigns owner role only to allowlisted emails", () => {
    process.env.INDEEDEE_OWNER_EMAILS = "exec@co.com, admin@co.com";
    expect(roleForEmail("exec@co.com")).toBe("owner");
    expect(roleForEmail("viewer@co.com")).toBe("viewer");
  });

  it("defaults to owner when allowlist is empty", () => {
    delete process.env.INDEEDEE_OWNER_EMAILS;
    expect(roleForEmail("anyone@co.com")).toBe("owner");
  });

  it("signs and verifies login OAuth state", () => {
    process.env.OAUTH_STATE_SECRET = "login-state-secret";
    const state = signLoginState("/?tab=connections");
    expect(verifyLoginState(state)).toBe("/?tab=connections");
  });

  it("creates session from Google profile", () => {
    process.env.INDEEDEE_SESSION_SECRET = "test-session-secret";
    process.env.INDEEDEE_OWNER_EMAILS = "exec@co.com";
    const { token, user } = sessionFromGoogleProfile({
      email: "exec@co.com",
      name: "Executive",
    });
    expect(user.role).toBe("owner");
    expect(verifySession(token)?.email).toBe("exec@co.com");
  });

  it("sets HttpOnly session cookie header", () => {
    const header = sessionSetCookieHeader("tok");
    expect(header).toContain("indeedee_session=tok");
    expect(header).toContain("HttpOnly");
  });
});

describe("Auth context resolution", () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it("prefers session cookie over headers", () => {
    process.env.INDEEDEE_SESSION_SECRET = "test-session-secret";
    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    const token = signSession({
      ownerId: "session-user",
      email: "session@co.com",
      role: "owner",
    });
    const req = {
      headers: {
        cookie: `indeedee_session=${token}`,
        "x-owner-id": "header-user",
        "x-role": "viewer",
      },
    };
    const ctx = resolveAuthContext(req as never);
    expect(ctx.ownerId).toBe("session-user");
    expect(ctx.role).toBe("owner");
  });

  it("uses dev header auth when SSO is disabled", () => {
    process.env.INDEEDEE_SSO_ENABLED = "false";
    delete process.env.GOOGLE_CLIENT_ID;
    const ctx = resolveAuthContext({
      headers: { "x-owner-id": "dev-user", "x-role": "viewer" },
    } as never);
    expect(ctx.devMode).toBe(true);
    expect(ctx.ownerId).toBe("dev-user");
    expect(ctx.role).toBe("viewer");
  });

  it("ignores spoofed headers for web API when SSO is enabled", () => {
    process.env.INDEEDEE_SSO_ENABLED = "true";
    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    const ctx = resolveAuthContext({
      headers: { "x-owner-id": "spoof", "x-role": "owner" },
    } as never);
    expect(ctx.user).toBeNull();
    expect(ctx.ownerId).toBe("anonymous");
  });

  it("allows trusted headers for MCP when SSO is enabled", () => {
    process.env.INDEEDEE_SSO_ENABLED = "true";
    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    const ctx = resolveAuthContext(
      { headers: { "x-owner-id": "mcp-user", "x-role": "owner" } } as never,
      { trustHeaders: true },
    );
    expect(ctx.ownerId).toBe("mcp-user");
    expect(isSsoEnabled()).toBe(true);
  });
});

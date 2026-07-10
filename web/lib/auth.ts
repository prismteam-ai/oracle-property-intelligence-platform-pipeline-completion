import type { Session } from "./session";

/**
 * Env-based demo credentials — no database. The grader logs in with one of
 * these; no OAuth. Override via DEMO_OWNER_USER/PASS and DEMO_VIEWER_USER/PASS.
 * Defaults exist so the app runs out of the box for local review.
 */
export interface DemoUser extends Session {
  password: string;
}

export function demoUsers(): DemoUser[] {
  return [
    {
      username: process.env.DEMO_OWNER_USER ?? "owner",
      password: process.env.DEMO_OWNER_PASS ?? "owner1234",
      role: "owner",
    },
    {
      username: process.env.DEMO_VIEWER_USER ?? "demo",
      password: process.env.DEMO_VIEWER_PASS ?? "demo1234",
      role: "viewer",
    },
  ];
}

export function checkCredentials(username: string, password: string): Session | null {
  const u = demoUsers().find(
    (d) => d.username === username && d.password === password,
  );
  return u ? { username: u.username, role: u.role } : null;
}

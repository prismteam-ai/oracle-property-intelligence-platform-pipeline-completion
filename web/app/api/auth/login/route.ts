import { NextRequest, NextResponse } from "next/server";
import { checkCredentials } from "@/lib/auth";
import { signToken, setSessionCookie } from "@/lib/session";

export async function POST(req: NextRequest) {
  const { username, password } = await req.json().catch(() => ({}));
  const session = checkCredentials(String(username ?? ""), String(password ?? ""));
  if (!session) {
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }
  await setSessionCookie(await signToken(session));
  return NextResponse.json({ ok: true, role: session.role });
}

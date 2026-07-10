"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    setBusy(false);
    if (res.ok) {
      router.push("/");
      router.refresh();
    } else {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "login failed");
    }
  }

  function fill(u: string, p: string) {
    setUsername(u);
    setPassword(p);
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="text-2xl font-bold tracking-tight">Oracle</div>
          <div className="text-sm text-[var(--color-muted)] mt-1">
            Palo Alto property intelligence · DuckDB + IPFS · MCP-ready
          </div>
        </div>

        <form onSubmit={submit} className="card p-6 space-y-4">
          <div>
            <label className="text-xs text-[var(--color-muted)]">Username</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              className="mt-1 w-full rounded-lg bg-[var(--color-panel-2)] border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            />
          </div>
          <div>
            <label className="text-xs text-[var(--color-muted)]">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="mt-1 w-full rounded-lg bg-[var(--color-panel-2)] border border-[var(--color-border)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            />
          </div>
          {error && <div className="text-xs text-[var(--color-bad)]">{error}</div>}
          <button type="submit" disabled={busy} className="btn btn-primary w-full">
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <div className="mt-4 text-center text-xs text-[var(--color-muted)]">
          Demo accounts (click to fill):
          <div className="mt-2 flex gap-2 justify-center">
            <button className="chip" onClick={() => fill("owner", "owner1234")}>
              owner / owner1234
            </button>
            <button className="chip" onClick={() => fill("demo", "demo1234")}>
              demo / demo1234
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}

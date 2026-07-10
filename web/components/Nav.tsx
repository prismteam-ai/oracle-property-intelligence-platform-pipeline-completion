"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const LINKS = [
  { href: "/", label: "Run summary" },
  { href: "/explore", label: "Explore & Ask" },
  { href: "/evals", label: "Relevance evals" },
  { href: "/artifacts", label: "IPFS artifacts" },
];

export default function Nav() {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="border-b border-[var(--color-border)] bg-[var(--color-panel-2)]">
      <div className="max-w-6xl mx-auto px-5 h-14 flex items-center gap-6">
        <Link href="/" className="font-bold tracking-tight">
          Oracle<span className="text-[var(--color-muted)] font-normal"> · Palo Alto</span>
        </Link>
        <nav className="flex gap-1 text-sm flex-1">
          {LINKS.map((l) => {
            const active = pathname === l.href;
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`px-3 py-1.5 rounded-lg ${
                  active
                    ? "bg-[var(--color-panel)] text-[var(--color-text)]"
                    : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        <button onClick={logout} className="text-xs text-[var(--color-muted)] hover:text-[var(--color-text)]">
          Sign out
        </button>
      </div>
    </header>
  );
}

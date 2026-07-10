import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Oracle — Property Intelligence (Palo Alto)",
  description:
    "Santa Clara County / Palo Alto property intelligence over DuckDB + IPFS, MCP-ready.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import JobPanel from "@/components/JobPanel";
import { getPlacesQuota } from "@/lib/queries";
import "./globals.css";

// The job bar reflects live state, so nothing here may be cached.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Leads",
  description: "Pipeline de leads de negócios locais brasileiros",
};

const NAV = [
  { href: "/", label: "Leads" },
  { href: "/discover", label: "Descobrir" },
  { href: "/queue", label: "Fila" },
  { href: "/coverage", label: "Cobertura" },
  { href: "/outreach", label: "Contatos" },
];

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Server-rendered so the remaining-quota label is correct on first paint
  // instead of appearing after the first client poll.
  const quota = await getPlacesQuota();

  return (
    <html lang="pt-BR">
      <body>
        <header
          style={{
            borderBottom: "1px solid var(--border)",
            background: "var(--panel)",
            padding: "0 16px",
            display: "flex",
            alignItems: "center",
            gap: 18,
            height: 44,
          }}
        >
          <strong style={{ fontSize: 13, letterSpacing: "-0.01em" }}>leads</strong>
          <nav style={{ display: "flex", gap: 14 }}>
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="link" style={{ fontSize: 12.5 }}>
                {n.label}
              </Link>
            ))}
          </nav>
        </header>
        <JobPanel initialQuotaLeft={quota.detailsLeft} />
        <main style={{ padding: 16 }}>{children}</main>
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import JobPanel from "@/components/JobPanel";
import NavTabs from "@/components/NavTabs";
import "./globals.css";

export const metadata: Metadata = {
  title: "Leads",
  description: "Pipeline de leads de negócios locais brasileiros",
};

/**
 * The shell is synchronous on purpose.
 *
 * It used to `await getPlacesQuota()` before emitting any HTML, which put a
 * database round trip in front of the header, the nav and every page below it —
 * on every navigation. It bought only one thing: the "N restantes" label next
 * to the Places step being correct on first paint rather than a moment later.
 * JobPanel already fetches /api/jobs (quota included) when it mounts, so that
 * label now fills itself in and nothing waits on the shell.
 *
 * Note there is no `dynamic = "force-dynamic"` here any more either. The layout
 * reads nothing; the pages below it declare their own dynamism. Keeping it here
 * only forced the shell to be re-rendered per request for no benefit.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
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
          <NavTabs />
        </header>
        <JobPanel />
        <main style={{ padding: 16 }}>{children}</main>
      </body>
    </html>
  );
}

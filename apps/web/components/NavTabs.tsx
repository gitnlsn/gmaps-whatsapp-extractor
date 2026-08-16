"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/", label: "Leads" },
  { href: "/discover", label: "Descobrir" },
  { href: "/offers", label: "Ofertas" },
  { href: "/queue", label: "Fila" },
  { href: "/coverage", label: "Cobertura" },
  { href: "/outreach", label: "Contatos" },
  { href: "/demand", label: "Demanda" },
];

/**
 * The tab's own pending state.
 *
 * Every route here is dynamic, so a click is a server round trip. Without this
 * the header gave no sign anything had happened and the old page just sat
 * there — the whole reason navigation felt broken. useLinkStatus has to be read
 * from inside the <Link>, hence the child component.
 */
function TabLabel({ label, active }: { label: string; active: boolean }) {
  const { pending } = useLinkStatus();
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 12.5,
        // Active wins over pending: the tab you are on should not look disabled
        // while some other part of the page streams in.
        color: active ? "var(--text)" : "var(--muted)",
        fontWeight: active ? 600 : 400,
        opacity: pending ? 0.55 : 1,
        transition: "opacity 120ms ease, color 120ms ease",
      }}
    >
      {label}
      {pending && <span className="spinner" aria-hidden />}
    </span>
  );
}

export default function NavTabs() {
  const pathname = usePathname();

  return (
    <nav style={{ display: "flex", gap: 14 }}>
      {NAV.map((n) => {
        // "/" would otherwise match every route.
        const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={active ? "page" : undefined}
            style={{
              textDecoration: "none",
              padding: "2px 0",
              // The underline is the persistent "you are here" marker; the
              // opacity change above is the transient "this is loading" one.
              borderBottom: active ? "2px solid var(--text)" : "2px solid transparent",
            }}
          >
            <TabLabel label={n.label} active={active} />
          </Link>
        );
      })}
    </nav>
  );
}

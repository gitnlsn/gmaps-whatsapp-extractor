"use client";

import Link from "next/link";
import { useLinkStatus } from "next/link";
import type { ComponentProps, ReactNode } from "react";

/**
 * Reports its own navigation as pending.
 *
 * useLinkStatus only works from inside the <Link> it describes, so the
 * indicator has to be a child component rather than something the parent
 * computes. Everything here is one <Link>'s business, which is why it is not
 * hoisted into a page-level "is anything loading" flag.
 */
function Pending({ children }: { children: ReactNode }) {
  const { pending } = useLinkStatus();
  return (
    <span
      // Dimming rather than swapping in a spinner keeps the label readable and
      // the row height fixed, so nothing shifts while the server responds.
      style={{
        opacity: pending ? 0.45 : 1,
        transition: "opacity 120ms ease",
      }}
    >
      {children}
      {pending && <span className="spinner" aria-hidden />}
    </span>
  );
}

/** Drop-in <Link> that dims and shows a spinner while its navigation is in flight. */
export default function PendingLink({
  children,
  ...props
}: ComponentProps<typeof Link>) {
  return (
    <Link {...props}>
      <Pending>{children}</Pending>
    </Link>
  );
}

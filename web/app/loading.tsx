import { StatSkeleton, FilterBarSkeleton, TableSkeleton } from "@/components/bits";

/**
 * The leads table shell, shown while the route's queries run.
 *
 * This file is doing more than showing a spinner. Next only prefetches a
 * dynamic route as far as its nearest loading boundary — with no loading.tsx
 * anywhere, `<Link>` prefetch had nothing to cache and every click sat on the
 * previous page until the server finished. The boundary is what makes the
 * navigation feel immediate; the skeleton is what it shows.
 */
export default function Loading() {
  return (
    <>
      <StatSkeleton />
      <FilterBarSkeleton />
      <TableSkeleton rows={14} cols={15} />
    </>
  );
}

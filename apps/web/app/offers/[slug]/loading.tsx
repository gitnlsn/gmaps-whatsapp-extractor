import { Shimmer, TableSkeleton } from "@/components/bits";

/**
 * The offer detail page runs the CNAE reality check, which used to be the
 * slowest query in the app. It is fast now, but the boundary still earns its
 * place: it is what lets Next prefetch this route from the offers list.
 */
export default function Loading() {
  return (
    <>
      <Shimmer w={240} h={18} />
      <div style={{ marginTop: 8, marginBottom: 14 }}>
        <Shimmer w="55%" h={10} />
      </div>

      <div className="panel" style={{ padding: 10, marginBottom: 12, display: "flex", gap: 18 }}>
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <Shimmer w={58} h={9} />
            <Shimmer w={34} h={13} />
          </div>
        ))}
      </div>

      <TableSkeleton rows={12} cols={9} />
    </>
  );
}

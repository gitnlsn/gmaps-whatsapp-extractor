import { Shimmer } from "@/components/bits";

/** Lead detail is a PK lookup, so this rarely lingers — but it stops the row
 *  click from feeling like nothing happened. */
export default function Loading() {
  return (
    <>
      <Shimmer w={300} h={18} />
      <div style={{ marginTop: 8, marginBottom: 14 }}>
        <Shimmer w={180} h={10} />
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="panel" style={{ padding: 12, minWidth: 240, flex: "1 1 240px" }}>
            <div style={{ marginBottom: 10 }}>
              <Shimmer w={92} h={10} />
            </div>
            {Array.from({ length: 5 }, (_, j) => (
              <div key={j} style={{ marginBottom: 7 }}>
                <Shimmer w={`${55 + ((i * 13 + j * 9) % 40)}%`} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

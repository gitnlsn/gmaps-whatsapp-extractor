"use client";

/**
 * The app's error boundary.
 *
 * There was none until now, which is part of why the outreach buttons read as
 * broken: a server action that threw rendered nothing at all, so a failure and
 * a no-op looked identical. Actions now return `{ ok, reason }` instead of
 * throwing, and this catches whatever still gets through.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="panel" style={{ padding: 16, maxWidth: 720 }}>
      <h1 style={{ fontSize: 15, fontWeight: 650, marginBottom: 6 }}>Algo quebrou nesta página</h1>
      <p className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        O erro está abaixo. Se falar em conexão, o Postgres provavelmente não está de pé —
        <code> npm run db:up</code>. Se falar em coluna ou relação inexistente, falta migrar —
        <code> npm run db:migrate</code>.
      </p>
      <pre
        style={{
          fontSize: 11.5,
          background: "var(--bg-alt, rgba(127,127,127,0.08))",
          padding: 10,
          borderRadius: 4,
          overflowX: "auto",
          whiteSpace: "pre-wrap",
        }}
      >
        {error.message}
        {error.digest ? `\n\ndigest: ${error.digest}` : ""}
      </pre>
      <button className="btn" onClick={reset} style={{ marginTop: 10 }}>
        tentar de novo
      </button>
    </div>
  );
}

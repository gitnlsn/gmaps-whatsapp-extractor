"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import PendingLink from "./PendingLink";

interface Props {
  ufs: { uf: string; n: number }[];
  params: Record<string, string | undefined>;
}

const SITE_OPTS = [
  ["", "site: qualquer"],
  ["none", "sem site"],
  ["dead", "site morto"],
  ["hub", "link hub"],
  ["builder", "construtor grátis"],
  ["noviewport", "não responsivo"],
  ["ok", "site ok"],
  ["unchecked", "não verificado"],
];

// Contactability is the default; phone type is a choice. Institutions register
// landlines, so filtering them out by default would hide the whole segment.
const CANAL_OPTS = [
  ["", "canal: qualquer"],
  ["mobile", "celular"],
  ["landline", "fixo"],
];

const STATUS_OPTS = [
  ["", "status: qualquer"],
  ["novo", "novo"],
  ["queued", "na fila"],
  ["sent", "enviado"],
  ["replied", "respondeu"],
  ["not_a_fit", "não serve"],
  ["opted_out", "opt-out"],
];

/**
 * Every filter lives in the URL, so any view stays linkable and shareable and
 * the page below stays a Server Component.
 *
 * It was a native <form method="GET">, which meant each "filtrar" was a full
 * document navigation: the browser tore down the page and rebuilt it, with no
 * way to show that anything was happening. Submitting through the router
 * instead keeps the same URLs and the same server rendering, but hands back an
 * `isPending` flag — so the button can say "filtrando…" and the stale table can
 * dim instead of just sitting there looking current.
 */
export default function FilterBar({ ufs, params }: Props) {
  const v = (k: string) => params[k] ?? "";
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const qs = new URLSearchParams();
    for (const [k, value] of data.entries()) {
      const s = String(value).trim();
      // Empty selects mean "any" — keep them out of the URL so a default view
      // stays a bare "/" and the unfiltered fast path can be detected.
      if (s) qs.set(k, s);
    }
    const query = qs.toString();
    startTransition(() => router.push(query ? `/?${query}` : "/"));
  }

  // Product-neutral: these describe the DATA (tier, site condition, age,
  // channel), not what is being sold. Anything offer-specific belongs in the
  // offer's own spec, not baked into a shared component.
  const presets: [string, string][] = [
    ["?tier=hot", "🔥 hot"],
    ["?minFit=4", "nota ≥ 4"],
    ["?site=none", "sem site"],
    ["?site=dead", "site morto"],
    ["?site=hub", "só Instagram/Linktree"],
    ["?canal=landline", "só fixo (instituições)"],
    ["?maxIdade=2", "empresa nova (≤2 anos)"],
  ];

  return (
    <div className="panel" style={{ padding: 10, marginBottom: 12 }}>
      <form
        method="GET"
        onSubmit={submit}
        style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}
      >
        <input
          className="inp"
          name="q"
          placeholder="nome ou CNPJ"
          defaultValue={v("q")}
          style={{ width: 170 }}
        />

        <select className="sel" name="uf" defaultValue={v("uf")}>
          <option value="">UF: todas</option>
          {ufs.map((u) => (
            <option key={u.uf} value={u.uf}>
              {u.uf} ({u.n.toLocaleString("pt-BR")})
            </option>
          ))}
        </select>

        <input
          className="inp"
          name="municipio"
          placeholder="município"
          defaultValue={v("municipio")}
          style={{ width: 130 }}
        />
        <input
          className="inp"
          name="cnae"
          placeholder="CNAE"
          defaultValue={v("cnae")}
          style={{ width: 80 }}
        />

        <select className="sel" name="tier" defaultValue={v("tier")}>
          <option value="">tier: qualquer</option>
          <option value="hot">hot</option>
          <option value="warm">warm</option>
          <option value="cold">cold</option>
        </select>

        <select className="sel" name="site" defaultValue={v("site")}>
          {SITE_OPTS.map(([val, label]) => (
            <option key={val} value={val}>
              {label}
            </option>
          ))}
        </select>

        <select className="sel" name="canal" defaultValue={v("canal")}>
          {CANAL_OPTS.map(([val, label]) => (
            <option key={val} value={val}>
              {label}
            </option>
          ))}
        </select>

        <select className="sel" name="minFit" defaultValue={v("minFit")}>
          <option value="">nota ≥</option>
          {[5, 4, 3].map((n) => (
            <option key={n} value={n}>
              nota ≥ {n}
            </option>
          ))}
        </select>

        <select className="sel" name="mei" defaultValue={v("mei")}>
          <option value="">MEI: tanto faz</option>
          <option value="sim">MEI</option>
          <option value="nao">não MEI</option>
        </select>

        <select className="sel" name="maxIdade" defaultValue={v("maxIdade")}>
          <option value="">idade: qualquer</option>
          <option value="1">≤ 1 ano</option>
          <option value="2">≤ 2 anos</option>
          <option value="5">≤ 5 anos</option>
        </select>

        <select className="sel" name="status" defaultValue={v("status")}>
          {STATUS_OPTS.map(([val, label]) => (
            <option key={val} value={val}>
              {label}
            </option>
          ))}
        </select>

        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? "filtrando…" : "filtrar"}
          {pending && <span className="spinner" aria-hidden />}
        </button>
        <PendingLink className="btn" href="/">
          limpar
        </PendingLink>
      </form>

      <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
        <span className="muted" style={{ fontSize: 11, alignSelf: "center" }}>
          atalhos:
        </span>
        {presets.map(([href, label]) => (
          <PendingLink
            key={href}
            href={href}
            className="chip chip-plain"
            style={{ padding: "2px 8px" }}
          >
            {label}
          </PendingLink>
        ))}
      </div>
    </div>
  );
}

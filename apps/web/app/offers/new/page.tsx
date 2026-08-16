import Link from "next/link";
import NewOfferForm from "./NewOfferForm";

export const dynamic = "force-dynamic";

export default function NewOfferPage() {
  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4 }}>
        <h1 style={{ fontSize: 16, fontWeight: 650 }}>Nova oferta</h1>
        <Link className="link" href="/offers" style={{ fontSize: 12.5 }}>
          ← ofertas
        </Link>
      </div>
      <p className="muted" style={{ marginBottom: 16, fontSize: 12, maxWidth: 760 }}>
        O modelo traduz o que você escrever em quais CNAEs procurar, que empresas descartar e
        como pontuar cada uma — e já monta a lista ranqueada. Ele erra: inventa código de CNAE
        e costuma pegar segmentos vizinhos demais. Por isso tudo é conferido contra os dados
        que você realmente carregou, e a página seguinte mostra o que ele mirou, quantas
        empresas isso alcança, e quais critérios do seu perfil <em>não</em> viraram filtro.
        Só depois disso é que gastar faz sentido.
      </p>
      <NewOfferForm />
    </>
  );
}

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
        O modelo traduz a descrição em um perfil de cliente ideal: quais CNAEs procurar, que
        empresas descartar e como pontuar cada uma. Ele erra — inventa código de CNAE e costuma
        pegar segmentos vizinhos demais —, então tudo é conferido contra os dados que você
        realmente carregou antes de valer alguma coisa. Você revisa antes de gastar qualquer
        outra chamada.
      </p>
      <NewOfferForm />
    </>
  );
}

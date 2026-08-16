import { parseOfferSpec, type OfferSpec } from "../../src/domain/spec";
import { saveSpec, setActive } from "../../src/usecases/offerRepo";
import type { Deps } from "../../src/ports/index";

/** The smallest spec `parseOfferSpec` accepts, with the knobs a test needs. */
export function makeSpec(over: Record<string, unknown> = {}): OfferSpec {
  const anchors = { "1": "não", "2": "quase não", "3": "talvez", "4": "sim", "5": "muito sim" };
  return parseOfferSpec({
    schemaVersion: 1,
    stage: "live",
    summary: "spec de teste",
    buyer: "dono do negócio",
    problem: "problema de teste",
    targeting: {
      cnaePrefixes: ["8599"],
      channels: ["mobile", "landline"],
      requireNomeFantasia: false,
      ...(over.targeting as object),
    },
    probes: over.probes ?? [],
    ranking: over.ranking ?? {},
    rubric: {
      axes: [{ key: "fit", label: "Fit", question: "Serve?", anchors }],
      recommendations: [{ value: "sim", label: "é cliente", when: "encaixa" }],
      ...(over.rubric as object),
    },
    messaging: {
      senderRole: "desenvolvedor",
      productNoun: "um app de teste",
      goal: "sell",
      asks: ["Como vocês fazem isso hoje?"],
      fallbackAsk: "Como vocês fazem isso hoje?",
      forbidden: [],
      ...(over.messaging as object),
    },
    presets: [],
  });
}

let cnpjSeq = 0;

/** A contactable, active lead. Only the columns the predicates actually read. */
export async function seedLead(
  deps: Deps,
  over: Record<string, unknown> = {}
): Promise<string> {
  const cnpj = String(10_000_000_000_000 + ++cnpjSeq);
  const row = {
    cnpj,
    razao_social: `EMPRESA ${cnpjSeq}`,
    nome_fantasia: `FANTASIA ${cnpjSeq}`,
    cnae_principal: "8599605",
    natureza_juridica: "2062",
    porte: "03",
    capital_social: 10000,
    opcao_mei: false,
    situacao: "ATIVA",
    uf: "SP",
    municipio_nome: "São Paulo",
    phone_e164: `+5511${String(900000000 + cnpjSeq)}`,
    is_mobile: true,
    email: null as string | null,
    source: "test",
    ...over,
  };

  const cols = Object.keys(row);
  const vals = Object.values(row);
  await deps.db.query(
    `INSERT INTO leads (${cols.join(",")})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`,
    vals
  );
  return cnpj;
}

export async function seedOffer(
  deps: Deps,
  id: string,
  spec: OfferSpec = makeSpec(),
  opts: { active?: boolean } = {}
): Promise<void> {
  await saveSpec(deps, {
    offerId: id,
    title: id,
    description: "oferta de teste",
    finalidade: "testar — sem contato real",
    spec,
    compiledBy: "test",
  });
  if (opts.active !== false) await setActive(deps, id);
}

export async function seedEnrichment(
  deps: Deps,
  cnpj: string,
  over: Record<string, unknown> = {}
): Promise<void> {
  const row = { cnpj, has_website: true, is_dead: false, ...over };
  const cols = Object.keys(row);
  await deps.db.query(
    `INSERT INTO enrichment (${cols.join(",")})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`,
    Object.values(row)
  );
}

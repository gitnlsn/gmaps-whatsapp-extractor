import { requireHttp, type Deps } from "../ports/index";

const MUNICIPIOS_URL =
  "https://servicodados.ibge.gov.br/api/v1/localidades/municipios";

// Aggregate 6579 = "População residente estimada", variable 9324, level N6 = município.
// periodos/-1 returns the most recent year available.
const POPULACAO_URL =
  "https://servicodados.ibge.gov.br/api/v3/agregados/6579/periodos/-1/variaveis/9324?localidades=N6[all]";

interface IbgeUf {
  sigla: string;
  nome: string;
}

interface IbgeMunicipio {
  id: number;
  nome: string;
  // UF is nested, and which branch carries it varies by record — there is no
  // top-level UF key. Both paths are optional in practice.
  microrregiao?: { mesorregiao?: { UF?: IbgeUf } };
  "regiao-imediata"?: { "regiao-intermediaria"?: { UF?: IbgeUf } };
}

function extractUf(m: IbgeMunicipio): string | undefined {
  return (
    m.microrregiao?.mesorregiao?.UF?.sigla ??
    m["regiao-imediata"]?.["regiao-intermediaria"]?.UF?.sigla
  );
}

async function fetchJson<T>(deps: Deps, url: string, label: string): Promise<T> {
  const res = await requireHttp(deps).fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`${label} failed (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

/** Fetches the population map keyed by the same 7-digit IBGE código as municipios.id. */
async function fetchPopulacao(deps: Deps): Promise<Map<number, number>> {
  interface Agregado {
    resultados: {
      series: {
        localidade: { id: string; nome: string };
        serie: Record<string, string>;
      }[];
    }[];
  }

  const data = await fetchJson<Agregado[]>(deps, POPULACAO_URL, "IBGE população");
  const out = new Map<number, number>();

  for (const variavel of data) {
    for (const resultado of variavel.resultados ?? []) {
      for (const s of resultado.series ?? []) {
        const id = Number(s.localidade.id);
        // Take the most recent year present in the series.
        const years = Object.keys(s.serie).sort();
        const latest = years[years.length - 1];
        const raw = latest ? s.serie[latest] : undefined;
        const value = raw === undefined ? NaN : Number(raw);
        if (Number.isFinite(id) && Number.isFinite(value)) {
          out.set(id, value);
        }
      }
    }
  }

  return out;
}

export async function loadMunicipios(deps: Deps): Promise<{ total: number; withPop: number }> {
  const { progress } = deps;
  progress.stage("ibge", "Municípios do IBGE");
  const municipios = await fetchJson<IbgeMunicipio[]>(deps, MUNICIPIOS_URL, "IBGE municípios");
  progress.info(`${municipios.length} municípios.`);

  progress.info("Buscando estimativas de população...");
  let populacao: Map<number, number>;
  try {
    populacao = await fetchPopulacao(deps);
    progress.info(`${populacao.size} population figures.`);
  } catch (err) {
    // Population only drives queue priority — a failure here shouldn't block
    // the geography load.
    progress.warn(
      `population fetch failed (${(err as Error).message}); ` +
        "continuing without it, priority ordering will be flat."
    );
    populacao = new Map();
  }

  const rows = municipios
    .map((m) => ({
      id: m.id,
      nome: m.nome,
      uf: extractUf(m),
      populacao: populacao.get(m.id) ?? null,
    }))
    .filter((r): r is { id: number; nome: string; uf: string; populacao: number | null } =>
      Boolean(r.uf)
    );

  const skipped = municipios.length - rows.length;
  if (skipped > 0) {
    progress.warn(`${skipped} município(s) had no resolvable UF and were skipped.`);
  }

  await deps.db.withTransaction(async (client) => {
    for (const r of rows) {
      await client.query(
        `INSERT INTO municipios (id, nome, uf, populacao)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE
           SET nome = EXCLUDED.nome,
               uf = EXCLUDED.uf,
               populacao = COALESCE(EXCLUDED.populacao, municipios.populacao)`,
        [r.id, r.nome, r.uf, r.populacao]
      );
    }
  });

  const withPop = rows.filter((r) => r.populacao !== null).length;
  progress.finish("ibge", `${rows.length} municípios (${withPop} com população)`);
  return { total: rows.length, withPop };
}

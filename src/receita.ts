import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform, pipeline as pipelineCb } from "node:stream";
import { promisify } from "node:util";
import { from as copyFrom } from "pg-copy-streams";
import { withClient, query } from "./db";
import { classifyReceitaPhone } from "./phone";

const pipeline = promisify(pipelineCb);

/**
 * Casa dos Dados' mirror of the Receita Federal open data, served through
 * Cloudflare. Receita's own host now sits behind a Nextcloud share page that
 * is not scriptable; the mirror publishes the identical monthly zips as a
 * plain directory index, so it is the practical source.
 * Origin: https://arquivos.receitafederal.gov.br/index.php/s/YggdBLfdninEJX9
 */
const RF_BASE = "https://dados-abertos-rf-cnpj.casadosdados.com.br/arquivos";
const DATA_DIR = join(process.cwd(), "data");

// ---------------------------------------------------------------- discovery

/** Finds the most recent YYYY-MM-DD snapshot published on the mirror. */
export async function latestPeriod(): Promise<string> {
  const res = await fetch(`${RF_BASE}/`);
  if (!res.ok) {
    throw new Error(
      `Could not list Receita periods (${res.status}). ` +
        `Pass --period YYYY-MM-DD explicitly (see ${RF_BASE}/).`
    );
  }
  const html = await res.text();
  const periods = [...html.matchAll(/href="(\d{4}-\d{2}-\d{2})\/"/g)].map((m) => m[1]);
  if (periods.length === 0) {
    throw new Error(`No YYYY-MM-DD snapshots found at ${RF_BASE}/. Pass --period.`);
  }
  return periods.sort().at(-1)!;
}

// ----------------------------------------------------------------- download

async function fileSize(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
}

/** Downloads with resume support — these files are large and connections drop. */
async function download(url: string, dest: string): Promise<void> {
  const existing = await fileSize(dest);

  const head = await fetch(url, { method: "HEAD" });
  if (!head.ok) throw new Error(`HEAD ${url} failed (${head.status})`);
  const total = Number(head.headers.get("content-length") ?? 0);

  if (existing !== undefined && total > 0 && existing === total) {
    console.log(`  ${dest.split("/").pop()} already complete (${fmtBytes(total)}).`);
    return;
  }

  const headers: Record<string, string> = {};
  let mode: "w" | "a" = "w";
  let start = 0;
  if (existing !== undefined && existing > 0 && existing < total) {
    headers.Range = `bytes=${existing}-`;
    mode = "a";
    start = existing;
    console.log(`  Resuming at ${fmtBytes(existing)} / ${fmtBytes(total)}...`);
  }

  const res = await fetch(url, { headers });
  if (!res.ok && res.status !== 206) {
    throw new Error(`GET ${url} failed (${res.status})`);
  }
  if (!res.body) throw new Error(`GET ${url} returned no body`);

  let received = start;
  let lastLog = Date.now();
  const progress = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (Date.now() - lastLog > 2000) {
        const pct = total ? ((received / total) * 100).toFixed(1) : "?";
        process.stdout.write(`\r  ${fmtBytes(received)} / ${fmtBytes(total)} (${pct}%)   `);
        lastLog = Date.now();
      }
      cb(null, chunk);
    },
  });

  await pipeline(
    Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    progress,
    createWriteStream(dest, { flags: mode })
  );
  process.stdout.write(`\r  ${fmtBytes(received)} / ${fmtBytes(total)} (100%)   \n`);
}

function fmtBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ------------------------------------------------------------- zip streaming

/**
 * Streams the single member of an RF zip as UTF-8 lines.
 * RF files are ISO-8859-1 and semicolon-delimited with quoted fields; we
 * transcode here so Postgres never has to deal with the legacy encoding.
 */
function streamZipLines(zipPath: string): Readable {
  const child = spawn("unzip", ["-p", zipPath], { stdio: ["ignore", "pipe", "pipe"] });

  let stderr = "";
  child.stderr.on("data", (d) => (stderr += String(d)));

  let remainder = "";
  const out = new Readable({ objectMode: true, read() {} });

  child.stdout.on("data", (chunk: Buffer) => {
    const text = remainder + chunk.toString("latin1");
    const lines = text.split("\n");
    remainder = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length > 0) out.push(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
  });

  child.stdout.on("end", () => {
    if (remainder.length > 0) out.push(remainder);
    out.push(null);
  });

  child.on("error", (err) => out.destroy(err));
  child.on("close", (code) => {
    if (code !== 0) {
      out.destroy(new Error(`unzip ${zipPath} exited ${code}: ${stderr.slice(0, 300)}`));
    }
  });

  return out;
}

/** Splits an RF line on ';' respecting the '"' quoting they use. */
function splitRfLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ";" && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function csvEscape(v: string): string {
  if (v === "") return "";
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function toCsvLine(fields: (string | null)[]): string {
  return fields.map((f) => (f === null ? "" : csvEscape(f))).join(",") + "\n";
}

// ------------------------------------------------------------------- layouts
// Column orders are fixed by the RF layout document (cnpj-metadados.pdf).

const ESTAB = {
  CNPJ_BASICO: 0,
  CNPJ_ORDEM: 1,
  CNPJ_DV: 2,
  MATRIZ_FILIAL: 3,
  NOME_FANTASIA: 4,
  SITUACAO: 5,
  DATA_SITUACAO: 6,
  DATA_INICIO: 10,
  CNAE_PRINCIPAL: 11,
  CNAE_SECUNDARIA: 12,
  TIPO_LOGRADOURO: 13,
  LOGRADOURO: 14,
  NUMERO: 15,
  BAIRRO: 17,
  CEP: 18,
  UF: 19,
  MUNICIPIO: 20,
  DDD_1: 21,
  TELEFONE_1: 22,
  EMAIL: 27,
} as const;

const EMPRESA = {
  CNPJ_BASICO: 0,
  RAZAO_SOCIAL: 1,
  NATUREZA_JURIDICA: 2,
  CAPITAL_SOCIAL: 4,
  PORTE: 5,
} as const;

const SIMPLES = {
  CNPJ_BASICO: 0,
  OPCAO_SIMPLES: 1,
  OPCAO_MEI: 4,
} as const;

// --------------------------------------------------------------- staging DDL

const STAGING_DDL = `
CREATE UNLOGGED TABLE IF NOT EXISTS rf_estab_stage (
  cnpj_basico TEXT, cnpj_ordem TEXT, cnpj_dv TEXT, matriz TEXT,
  nome_fantasia TEXT, situacao TEXT, data_inicio TEXT,
  cnae_principal TEXT, cnae_secundarias TEXT,
  logradouro TEXT, bairro TEXT, cep TEXT, uf TEXT, municipio_rf TEXT,
  ddd TEXT, telefone TEXT, email TEXT
);
CREATE UNLOGGED TABLE IF NOT EXISTS rf_empresa_stage (
  cnpj_basico TEXT PRIMARY KEY, razao_social TEXT, natureza_juridica TEXT,
  capital_social TEXT, porte TEXT
);
CREATE UNLOGGED TABLE IF NOT EXISTS rf_simples_stage (
  cnpj_basico TEXT PRIMARY KEY, opcao_simples TEXT, opcao_mei TEXT
);
CREATE UNLOGGED TABLE IF NOT EXISTS rf_municipio_stage (
  codigo TEXT PRIMARY KEY, descricao TEXT
);
`;

// -------------------------------------------------------------------- loader

export interface LoadOptions {
  period?: string;
  uf?: string[];
  cnae?: string[];
  /** Which numbered Estabelecimentos/Empresas parts to fetch (0-9). */
  parts?: number[];
  dryRun?: boolean;
  keepFiles?: boolean;
  /** Re-run only the staging -> leads join. Staging tables must be populated. */
  normalizeOnly?: boolean;
}

interface FilterStats {
  read: number;
  kept: number;
  withPhone: number;
  withMobileShape: number;
}

/**
 * Streams one zip through a row filter straight into a COPY, so nothing is
 * ever materialized on disk beyond the compressed download itself.
 */
async function copyFiltered(
  zipPath: string,
  table: string,
  columns: string[],
  mapRow: (f: string[], stats: FilterStats) => (string | null)[] | null,
  stats: FilterStats
): Promise<void> {
  await withClient(async (client) => {
    const stream = client.query(
      copyFrom(`COPY ${table} (${columns.join(",")}) FROM STDIN WITH (FORMAT csv)`)
    );

    const lines = streamZipLines(zipPath);

    await new Promise<void>((resolve, reject) => {
      stream.on("error", reject);
      stream.on("finish", resolve);
      lines.on("error", reject);

      lines.on("data", (line: string) => {
        stats.read++;
        const fields = splitRfLine(line);
        const row = mapRow(fields, stats);
        if (row) {
          stats.kept++;
          if (!stream.write(toCsvLine(row))) {
            lines.pause();
            stream.once("drain", () => lines.resume());
          }
        }
        if (stats.read % 1_000_000 === 0) {
          process.stdout.write(
            `\r    read ${stats.read.toLocaleString()} / kept ${stats.kept.toLocaleString()}   `
          );
        }
      });

      lines.on("end", () => stream.end());
    });
  });
}

/**
 * Loads the CNAE dictionary (~1,358 codes with descriptions).
 *
 * Separate from `loadReceita` on purpose: this file is ~40 KB, while a real
 * load is gigabytes. Needing a code's name should never mean re-downloading
 * the base.
 *
 * The dictionary is what makes "this CNAE does not exist" distinguishable from
 * "this CNAE exists but you have not loaded that slice" — two situations that
 * look identical from a row count of zero and need opposite fixes.
 */
export async function loadCnaes(): Promise<void> {
  const period = await latestPeriod();
  const zip = join(DATA_DIR, "Cnaes.zip");

  console.log(`Receita Federal period: ${period}`);
  await download(`${RF_BASE}/${period}/Cnaes.zip`, zip);

  await withClient((c) => c.query("TRUNCATE cnaes"));

  const stats: FilterStats = { read: 0, kept: 0, withPhone: 0, withMobileShape: 0 };
  await copyFiltered(
    zip,
    "cnaes",
    ["codigo", "descricao"],
    (f) => (f[0] ? [f[0], f[1] ?? ""] : null),
    stats
  );

  console.log(`\n${stats.kept.toLocaleString()} CNAEs carregados.`);

  // Immediately useful, and the fastest way to see whether the load worked.
  const rows = await query<{ codigo: string; descricao: string; n: string }>(
    `SELECT c.codigo, c.descricao, count(l.cnpj)::text AS n
       FROM cnaes c
       LEFT JOIN leads l ON l.cnae_principal = c.codigo
      WHERE c.codigo LIKE '85%'
      GROUP BY c.codigo, c.descricao
      ORDER BY c.codigo`
  );
  if (rows.length) {
    console.log("\nEducação (CNAE 85) — códigos e quantos leads você já tem:");
    for (const r of rows) {
      console.log(
        `  ${r.codigo}  ${Number(r.n).toLocaleString().padStart(9)}  ${r.descricao}`
      );
    }
  }
}

/** Brazilian mobile numbers have 9 digits and start with 9. Cheap prefilter. */
function looksMobile(telefone: string): boolean {
  const d = telefone.replace(/\D/g, "");
  return d.length === 9 && d.startsWith("9");
}

export async function loadReceita(opts: LoadOptions): Promise<void> {
  const period = opts.period ?? (await latestPeriod());
  const parts = opts.parts ?? [0];
  const ufs = opts.uf?.map((u) => u.toUpperCase());
  const cnaes = opts.cnae;

  console.log(`Receita Federal period: ${period}`);
  console.log(`Parts: ${parts.join(", ")}  (0-9 available; each ~1/10 of the base)`);
  console.log(`UF filter: ${ufs?.join(",") ?? "all"}`);
  console.log(`CNAE prefix filter: ${cnaes?.join(",") ?? "all"}`);

  if (opts.dryRun) {
    console.log("\n--dry-run: listing what would be downloaded, then exiting.\n");
    for (const p of parts) {
      for (const name of [`Estabelecimentos${p}.zip`, `Empresas${p}.zip`]) {
        const url = `${RF_BASE}/${period}/${name}`;
        const head = await fetch(url, { method: "HEAD" });
        const size = Number(head.headers.get("content-length") ?? 0);
        console.log(`  ${head.ok ? "OK " : "MISS"}  ${name}  ${fmtBytes(size)}`);
      }
    }
    for (const name of ["Simples.zip", "Municipios.zip"]) {
      const url = `${RF_BASE}/${period}/${name}`;
      const head = await fetch(url, { method: "HEAD" });
      const size = Number(head.headers.get("content-length") ?? 0);
      console.log(`  ${head.ok ? "OK " : "MISS"}  ${name}  ${fmtBytes(size)}`);
    }
    return;
  }

  await mkdir(DATA_DIR, { recursive: true });
  await withClient((c) => c.query(STAGING_DDL));

  // The staging load is the expensive part (gigabytes, tens of millions of
  // rows). Re-running just the join lets a failure there be fixed without
  // paying for the download again.
  if (opts.normalizeOnly) {
    const [{ n }] = await query<{ n: string }>(
      "SELECT count(*)::text AS n FROM rf_estab_stage"
    );
    if (Number(n) === 0) {
      throw new Error("--normalize-only requires populated staging tables; rf_estab_stage is empty.");
    }
    console.log(`\nRe-normalizing ${Number(n).toLocaleString()} staged establishments...`);
    await normalize(period);
    await reportFillRates();
    return;
  }

  await withClient((c) =>
    c.query(
      "TRUNCATE rf_estab_stage, rf_empresa_stage, rf_simples_stage, rf_municipio_stage"
    )
  );

  // --- reference: municípios (small, maps RF's TOM code to a name) ---
  console.log("\n[1/5] Municípios (reference table)");
  {
    const zip = join(DATA_DIR, "Municipios.zip");
    await download(`${RF_BASE}/${period}/Municipios.zip`, zip);
    const stats: FilterStats = { read: 0, kept: 0, withPhone: 0, withMobileShape: 0 };
    await copyFiltered(
      zip,
      "rf_municipio_stage",
      ["codigo", "descricao"],
      (f) => (f[0] ? [f[0], f[1] ?? ""] : null),
      stats
    );
    console.log(`  ${stats.kept.toLocaleString()} municípios.`);
  }

  // --- Estabelecimentos FIRST (the big one; filtered while streaming) ---
  //
  // Order matters. Estabelecimentos is where the UF/CNAE filter applies, so
  // loading it first tells us exactly which cnpj_basico values we care about.
  // Empresas and Simples can then skip the ~40M rows that will never join —
  // on a filtered load that turns two multi-minute passes into seconds.
  console.log("\n[2/5] Estabelecimentos");
  const total: FilterStats = { read: 0, kept: 0, withPhone: 0, withMobileShape: 0 };

  for (const p of parts) {
    const zip = join(DATA_DIR, `Estabelecimentos${p}.zip`);
    console.log(`  Estabelecimentos${p}.zip`);
    await download(`${RF_BASE}/${period}/Estabelecimentos${p}.zip`, zip);

    await copyFiltered(
      zip,
      "rf_estab_stage",
      [
        "cnpj_basico",
        "cnpj_ordem",
        "cnpj_dv",
        "matriz",
        "nome_fantasia",
        "situacao",
        "data_inicio",
        "cnae_principal",
        "cnae_secundarias",
        "logradouro",
        "bairro",
        "cep",
        "uf",
        "municipio_rf",
        "ddd",
        "telefone",
        "email",
      ],
      (f, stats) => {
        // Only ATIVA (02) — dead registrations are the single largest junk source.
        if (f[ESTAB.SITUACAO] !== "02") return null;
        if (ufs && !ufs.includes(f[ESTAB.UF])) return null;
        if (cnaes && !cnaes.some((c) => (f[ESTAB.CNAE_PRINCIPAL] ?? "").startsWith(c))) {
          return null;
        }

        const tel = f[ESTAB.TELEFONE_1] ?? "";
        if (tel) stats.withPhone++;
        if (looksMobile(tel)) stats.withMobileShape++;

        const logradouro = [
          f[ESTAB.TIPO_LOGRADOURO],
          f[ESTAB.LOGRADOURO],
          f[ESTAB.NUMERO],
        ]
          .filter(Boolean)
          .join(" ")
          .trim();

        return [
          f[ESTAB.CNPJ_BASICO],
          f[ESTAB.CNPJ_ORDEM],
          f[ESTAB.CNPJ_DV],
          f[ESTAB.MATRIZ_FILIAL],
          f[ESTAB.NOME_FANTASIA] ?? "",
          f[ESTAB.SITUACAO],
          f[ESTAB.DATA_INICIO] ?? "",
          f[ESTAB.CNAE_PRINCIPAL] ?? "",
          f[ESTAB.CNAE_SECUNDARIA] ?? "",
          logradouro,
          f[ESTAB.BAIRRO] ?? "",
          f[ESTAB.CEP] ?? "",
          f[ESTAB.UF] ?? "",
          f[ESTAB.MUNICIPIO] ?? "",
          f[ESTAB.DDD_1] ?? "",
          tel,
          f[ESTAB.EMAIL] ?? "",
        ];
      },
      total
    );
    console.log(
      `\n    read ${total.read.toLocaleString()} / kept ${total.kept.toLocaleString()}`
    );
    if (!opts.keepFiles) await unlink(zip).catch(() => {});
  }

  // Which company roots survived the filter. Used to skip irrelevant rows in
  // the next two passes. Only worth holding in memory when the filter actually
  // narrowed things; an unfiltered national load would be ~60M entries.
  let wanted: Set<string> | undefined;
  const MAX_SET = 4_000_000;
  if (ufs || cnaes) {
    const rows = await query<{ cnpj_basico: string }>(
      "SELECT DISTINCT cnpj_basico FROM rf_estab_stage"
    );
    if (rows.length <= MAX_SET) {
      wanted = new Set(rows.map((r) => r.cnpj_basico));
      console.log(`  ${wanted.size.toLocaleString()} distinct company roots to join.`);
    }
  }
  const keep = (basico: string) => !wanted || wanted.has(basico);

  // --- Empresas (razão social, porte, capital) ---
  console.log("\n[3/5] Empresas");
  for (const p of parts) {
    const zip = join(DATA_DIR, `Empresas${p}.zip`);
    console.log(`  Empresas${p}.zip`);
    await download(`${RF_BASE}/${period}/Empresas${p}.zip`, zip);
    const stats: FilterStats = { read: 0, kept: 0, withPhone: 0, withMobileShape: 0 };
    await copyFiltered(
      zip,
      "rf_empresa_stage",
      ["cnpj_basico", "razao_social", "natureza_juridica", "capital_social", "porte"],
      (f) => {
        const basico = f[EMPRESA.CNPJ_BASICO];
        if (!basico || !keep(basico)) return null;
        return [
          basico,
          f[EMPRESA.RAZAO_SOCIAL] ?? "",
          f[EMPRESA.NATUREZA_JURIDICA] ?? "",
          f[EMPRESA.CAPITAL_SOCIAL] ?? "",
          f[EMPRESA.PORTE] ?? "",
        ];
      },
      stats
    );
    console.log(
      `\n    read ${stats.read.toLocaleString()} / kept ${stats.kept.toLocaleString()}`
    );
    if (!opts.keepFiles) await unlink(zip).catch(() => {});
  }

  // --- Simples / MEI flags ---
  console.log("\n[4/5] Simples / MEI");
  {
    const zip = join(DATA_DIR, "Simples.zip");
    await download(`${RF_BASE}/${period}/Simples.zip`, zip);
    const stats: FilterStats = { read: 0, kept: 0, withPhone: 0, withMobileShape: 0 };
    await copyFiltered(
      zip,
      "rf_simples_stage",
      ["cnpj_basico", "opcao_simples", "opcao_mei"],
      (f) => {
        const basico = f[SIMPLES.CNPJ_BASICO];
        if (!basico || !keep(basico)) return null;
        return [basico, f[SIMPLES.OPCAO_SIMPLES] ?? "", f[SIMPLES.OPCAO_MEI] ?? ""];
      },
      stats
    );
    console.log(
      `\n    read ${stats.read.toLocaleString()} / kept ${stats.kept.toLocaleString()}`
    );
    if (!opts.keepFiles) await unlink(zip).catch(() => {});
  }

  // --- Normalize into `leads` ---
  console.log("\n[5/5] Normalizing into leads");
  await normalize(period);

  // The dashboard rollups are derived from `leads`, and this is the only stage
  // that writes it — so this is the one place they can go stale. Refreshing
  // here is what lets the web app read precomputed counts instead of
  // aggregating 2.1M rows on every page load.
  console.log("\nRefreshing dashboard rollups");
  const { refreshRollupsQuietly } = await import("./rollups");
  await refreshRollupsQuietly();

  await reportFillRates();
}

/** The fill rate is the number that decides whether this data source works. */
async function reportFillRates(): Promise<void> {
  const [fill] = await query<{
    total: string;
    with_phone: string;
    mobile: string;
    with_email: string;
  }>(`
    SELECT count(*)::text                                          AS total,
           count(*) FILTER (WHERE phone_raw <> '')::text           AS with_phone,
           count(*) FILTER (WHERE is_mobile)::text                 AS mobile,
           count(*) FILTER (WHERE email IS NOT NULL AND email <> '')::text AS with_email
    FROM leads
  `);

  const t = Number(fill.total) || 1;
  console.log("\n--- Fill rates (the number that decides everything) ---");
  console.log(`  leads:        ${Number(fill.total).toLocaleString()}`);
  console.log(
    `  with phone:   ${Number(fill.with_phone).toLocaleString()} (${((Number(fill.with_phone) / t) * 100).toFixed(1)}%)`
  );
  console.log(
    `  MOBILE:       ${Number(fill.mobile).toLocaleString()} (${((Number(fill.mobile) / t) * 100).toFixed(1)}%)`
  );
  console.log(
    `  with email:   ${Number(fill.with_email).toLocaleString()} (${((Number(fill.with_email) / t) * 100).toFixed(1)}%)`
  );

  const mobilePct = (Number(fill.mobile) / t) * 100;
  if (mobilePct < 20) {
    console.log(
      `\n  ⚠️  Mobile fill is ${mobilePct.toFixed(1)}%, below the 20% threshold in the plan.\n` +
        `      Receita phone data is often the accountant's landline. Consider whether\n` +
        `      Places-based discovery needs to carry more of the load.`
    );
  }
}

async function normalize(period: string): Promise<void> {
  // Link RF's município code (TOM) to the IBGE code by normalized name.
  //
  // RF's reference table carries only código + descrição, with no UF, and
  // dozens of Brazilian city names repeat across states ("Bom Jesus" exists in
  // nine). So one RF code legitimately lands on several IBGE rows here, and the
  // join below must disambiguate with the establishment's own UF.
  await withClient((c) =>
    c.query(`
      UPDATE municipios m
      SET cod_rf = s.codigo::int
      FROM (
        SELECT DISTINCT ON (norm_name(descricao)) codigo, descricao
        FROM rf_municipio_stage
        WHERE codigo ~ '^[0-9]+$'
        ORDER BY norm_name(descricao), codigo
      ) s
      WHERE norm_name(m.nome) = norm_name(s.descricao)
        AND m.cod_rf IS DISTINCT FROM s.codigo::int
    `)
  );

  const sourceUrl = `${RF_BASE}/${period}/`;

  await withClient((c) =>
    c.query(
      `
      INSERT INTO leads (
        cnpj, razao_social, nome_fantasia, cnae_principal, cnae_secundarias,
        natureza_juridica, porte, capital_social, opcao_mei, opcao_simples,
        data_inicio_atividade, situacao, matriz,
        cep, uf, municipio_id, municipio_nome, bairro, logradouro,
        phone_raw, phone_ddd, phone_local, email, source, source_url
      )
      SELECT DISTINCT ON (e.cnpj_basico || e.cnpj_ordem || e.cnpj_dv)
        e.cnpj_basico || e.cnpj_ordem || e.cnpj_dv,
        NULLIF(emp.razao_social, ''),
        NULLIF(e.nome_fantasia, ''),
        NULLIF(e.cnae_principal, ''),
        NULLIF(e.cnae_secundarias, ''),
        NULLIF(emp.natureza_juridica, ''),
        CASE emp.porte
          WHEN '01' THEN 'MICRO EMPRESA'
          WHEN '03' THEN 'EPP'
          WHEN '05' THEN 'DEMAIS'
          ELSE NULLIF(emp.porte, '')
        END,
        NULLIF(replace(emp.capital_social, ',', '.'), '')::numeric,
        sim.opcao_mei = 'S',
        sim.opcao_simples = 'S',
        CASE WHEN e.data_inicio ~ '^[0-9]{8}$' AND e.data_inicio <> '00000000'
             THEN to_date(e.data_inicio, 'YYYYMMDD') END,
        'ATIVA',
        e.matriz = '1',
        NULLIF(e.cep, ''),
        NULLIF(e.uf, ''),
        m.id,
        m.nome,
        NULLIF(e.bairro, ''),
        NULLIF(e.logradouro, ''),
        CASE WHEN e.telefone <> '' THEN e.ddd || e.telefone ELSE '' END,
        NULLIF(e.ddd, ''),
        NULLIF(e.telefone, ''),
        NULLIF(lower(e.email), ''),
        'receita_federal',
        $1
      FROM rf_estab_stage e
      LEFT JOIN rf_empresa_stage emp ON emp.cnpj_basico = e.cnpj_basico
      LEFT JOIN rf_simples_stage sim ON sim.cnpj_basico = e.cnpj_basico
      -- Resolve município in two hops instead of via a stored code.
      -- RF's reference table has no UF, so a code cannot be mapped to a single
      -- IBGE row on its own (dozens of city names repeat across states). But
      -- the code does give us the NAME, and the establishment gives us the UF —
      -- and (name, UF) is unique. Going through the name lifts the match rate
      -- from 95% to ~100%.
      LEFT JOIN rf_municipio_stage rm
        ON rm.codigo ~ '^[0-9]+$'
       AND rm.codigo::int = NULLIF(e.municipio_rf, '')::int
      LEFT JOIN municipios m
        ON norm_name(m.nome) = norm_name(rm.descricao)
       AND m.uf = e.uf
      WHERE e.cnpj_basico <> ''
      ORDER BY e.cnpj_basico || e.cnpj_ordem || e.cnpj_dv, m.id NULLS LAST
      ON CONFLICT (cnpj) DO UPDATE SET
        razao_social          = COALESCE(EXCLUDED.razao_social, leads.razao_social),
        nome_fantasia         = COALESCE(EXCLUDED.nome_fantasia, leads.nome_fantasia),
        cnae_principal        = EXCLUDED.cnae_principal,
        situacao              = EXCLUDED.situacao,
        porte                 = COALESCE(EXCLUDED.porte, leads.porte),
        capital_social        = COALESCE(EXCLUDED.capital_social, leads.capital_social),
        opcao_mei             = COALESCE(EXCLUDED.opcao_mei, leads.opcao_mei),
        data_inicio_atividade = COALESCE(EXCLUDED.data_inicio_atividade, leads.data_inicio_atividade),
        phone_raw             = EXCLUDED.phone_raw,
        phone_ddd             = EXCLUDED.phone_ddd,
        phone_local           = EXCLUDED.phone_local,
        email                 = COALESCE(EXCLUDED.email, leads.email),
        -- Must be refreshed too, or a re-run silently keeps a stale/NULL
        -- município even after the resolution logic improves.
        municipio_id          = COALESCE(EXCLUDED.municipio_id, leads.municipio_id),
        municipio_nome        = COALESCE(EXCLUDED.municipio_nome, leads.municipio_nome),
        uf                    = COALESCE(EXCLUDED.uf, leads.uf),
        cep                   = COALESCE(EXCLUDED.cep, leads.cep),
        bairro                = COALESCE(EXCLUDED.bairro, leads.bairro),
        logradouro            = COALESCE(EXCLUDED.logradouro, leads.logradouro)
      `,
      [sourceUrl]
    )
  );

  // Roughly 0.16% of RF names differ from IBGE's by spelling rather than by
  // ambiguity — "Parati"/"Paraty", "Brasopolis"/"Brazópolis", "Santana do
  // Livramento"/"Sant'Ana do Livramento". Trigram similarity, restricted to
  // the same UF, resolves those without risking a wrong cross-state match.
  console.log("  Resolving remaining município names by similarity...");
  await withClient((c) =>
    c.query(`
      UPDATE leads l
      SET municipio_id = best.id, municipio_nome = best.nome
      FROM (
        SELECT DISTINCT ON (e.municipio_rf, e.uf)
               e.municipio_rf, e.uf, m.id, m.nome
        FROM rf_estab_stage e
        JOIN rf_municipio_stage rm
          ON rm.codigo ~ '^[0-9]+$'
         AND rm.codigo::int = NULLIF(e.municipio_rf, '')::int
        JOIN municipios m ON m.uf = e.uf
        WHERE similarity(norm_name(m.nome), norm_name(rm.descricao)) > 0.55
        ORDER BY e.municipio_rf, e.uf,
                 similarity(norm_name(m.nome), norm_name(rm.descricao)) DESC
      ) best
      JOIN rf_estab_stage e2
        ON e2.municipio_rf = best.municipio_rf AND e2.uf = best.uf
      WHERE l.cnpj = e2.cnpj_basico || e2.cnpj_ordem || e2.cnpj_dv
        AND l.municipio_id IS NULL
    `)
  );

  console.log("  Classifying phone numbers...");
  await classifyPending();
}

/**
 * Runs libphonenumber over staged raw numbers. Kept in Node rather than SQL
 * because DDD validity and number-type rules are not expressible in SQL, and
 * `classifyPhone` is already the tested implementation.
 */
export async function classifyPending(batchSize = 20000): Promise<void> {
  let processed = 0;
  let mobiles = 0;

  for (;;) {
    const rows = await query<{ cnpj: string; phone_ddd: string | null; phone_local: string | null }>(
      `SELECT cnpj, phone_ddd, phone_local FROM leads
       WHERE phone_local IS NOT NULL AND is_mobile IS NULL
       LIMIT $1`,
      [batchSize]
    );
    if (rows.length === 0) break;

    const cnpjs: string[] = [];
    const e164s: (string | null)[] = [];
    const isMobiles: boolean[] = [];

    for (const r of rows) {
      const c = classifyReceitaPhone(r.phone_ddd ?? "", r.phone_local ?? "");
      cnpjs.push(r.cnpj);
      e164s.push(c?.e164 ?? null);
      isMobiles.push(c?.isMobile ?? false);
      if (c?.isMobile) mobiles++;
    }

    await withClient((client) =>
      client.query(
        `UPDATE leads AS l
         SET phone_e164 = u.e164, is_mobile = u.is_mobile
         FROM unnest($1::text[], $2::text[], $3::boolean[]) AS u(cnpj, e164, is_mobile)
         WHERE l.cnpj = u.cnpj`,
        [cnpjs, e164s, isMobiles]
      )
    );

    processed += rows.length;
    process.stdout.write(`\r    classified ${processed.toLocaleString()} (${mobiles.toLocaleString()} mobile)   `);
  }

  // Rows with no number at all still need is_mobile set so the loop terminates.
  await withClient((c) =>
    c.query("UPDATE leads SET is_mobile = FALSE WHERE phone_local IS NULL AND is_mobile IS NULL")
  );

  if (processed > 0) console.log("");
}

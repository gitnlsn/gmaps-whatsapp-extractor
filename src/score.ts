import { query, withClient } from "./db";
import { completeJson, LlmError, modelFor } from "./llm";

// ------------------------------------------------------------------ rubric
// Anchored: each level is described concretely, so the model weighs evidence
// instead of guessing. Kept as one static block so it can be prompt-cached.

const RUBRIC = `Você avalia pequenos negócios brasileiros como potenciais clientes de um desenvolvedor solo que vende duas coisas:

A) SITE / LANDING PAGE
B) AUTOMAÇÃO DE WHATSAPP / CHATBOT de atendimento

Para cada negócio, dê duas notas independentes de 1 a 5.

IMPORTANTE — os dados vêm da Receita Federal, que NÃO tem campo de site.
"site: NÃO ENCONTRADO" significa que não achamos um site, não que ele não exista.
Nesse caso use confidence "low" ou "medium", nunca "high", e não dê 5.
Nota 5 exige EVIDÊNCIA POSITIVA: um site que respondeu e está morto, é Linktree,
ou não abre no celular.

web_fit — quanto ele precisa de um SITE:
  5 = verificamos e o site está morto/404, OU o "site" é só Linktree/Instagram.
      Evidência concreta, não ausência de informação.
  4 = tem site mas em construtor grátis (wixsite.com, negocio.site, business.site,
      wordpress.com) ou sem HTTPS, ou sem meta viewport (não abre direito no celular).
  3-4 = nenhum site encontrado e sem domínio próprio: provável ausência de presença
      digital, mas é indício, não prova. Use confidence "low"/"medium".
  3 = tem site funcional mas parado: rodapé com ano <= 2021, sem formulário,
      sem caminho de contato.
  2 = site funcional e razoável, só daria para melhorar.
  1 = site moderno, rápido, responsivo, com contato claro. Não é cliente.

chatbot_fit — quanto ele precisa de AUTOMAÇÃO DE ATENDIMENTO:
  5 = já vende por WhatsApp (link wa.me no site/bio) e não tem nenhum sistema de
      agendamento ou formulário. Volume alto de clientes.
  4 = negócio de atendimento (clínica, salão, barbearia, oficina, restaurante,
      pet shop) sem nenhum caminho de contato automatizado no site.
  3 = tem formulário ou telefone, mas nada de agendamento/automação.
  2 = já tem algum sistema de agendamento ou atendimento estruturado.
  1 = empresa sem atendimento ao público, ou já totalmente automatizada.

REGRAS:
- Baseie-se SOMENTE nas evidências fornecidas. Não invente fatos.
- Se as evidências forem insuficientes, use confidence "cannot_determine" e
  notas null.
- Empresa muito nova (< 2 anos) tende a precisar mais de site.
- MEI e capital social baixo = ticket menor, mas ainda cliente.
- tier: "hot" se a maior nota for 5, "warm" se for 4, "cold" se for <= 3.
- offer: "site" | "chatbot" | "both" | "none" — qual produto oferecer.

O campo MAIS IMPORTANTE é "hook": UMA frase em português do Brasil, informal,
que você mandaria no WhatsApp, citando um fato CONCRETO e específico daquele
negócio.

REGRA ABSOLUTA DO HOOK — nunca afirme algo que não foi verificado.
Se o dado diz "site NÃO ENCONTRADO", você NÃO sabe que eles não têm site.
Dizer "vi que vocês não têm site" é mentira e queima o contato.
Nesse caso, ou fale do que você REALMENTE sabe (ramo, cidade, tempo de
abertura), ou PERGUNTE em vez de afirmar.
  PROIBIDO: "vi que vocês não têm site"
  PROIBIDO: "vi que vocês ainda não têm sistema de agendamento"
  OK:       "vi que a barbearia abriu esse ano aqui em Juiz de Fora — vocês já
             têm site ou tá tudo no Instagram por enquanto?"
  OK:       "procurei a lanchonete no Google e não achei site de vocês —
             é proposital ou ainda tá na lista?"

Quando HOUVER evidência verificada, use o fato direto:
  BOM: "vi que o site de vocês tá no ar mas não abre direito no celular"
  BOM: "o link de vocês leva pro Linktree — quem procura no Google não acha"
  BOM: "o site de vocês tá fora do ar (dá erro 404)"

Se não houver nada específico e honesto a dizer, deixe hook null.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        // justification first so generation is conditioned on the reasoning.
        required: [
          "cnpj",
          "justification",
          "web_fit",
          "chatbot_fit",
          "confidence",
          "tier",
          "offer",
          "evidence",
          "hook",
        ],
        properties: {
          cnpj: { type: "string" },
          justification: { type: "string" },
          web_fit: { type: ["integer", "null"], minimum: 1, maximum: 5 },
          chatbot_fit: { type: ["integer", "null"], minimum: 1, maximum: 5 },
          confidence: {
            type: "string",
            enum: ["high", "medium", "low", "cannot_determine"],
          },
          tier: { type: "string", enum: ["hot", "warm", "cold"] },
          offer: { type: "string", enum: ["site", "chatbot", "both", "none"] },
          evidence: { type: "array", items: { type: "string" } },
          hook: { type: ["string", "null"] },
        },
      },
    },
  },
} as const;

interface ScoreResult {
  cnpj: string;
  justification: string;
  web_fit: number | null;
  chatbot_fit: number | null;
  confidence: string;
  tier: string;
  offer: string;
  evidence: string[];
  hook: string | null;
}

// ------------------------------------------------------------- candidate row

interface Candidate {
  cnpj: string;
  nome: string | null;
  cnae: string | null;
  porte: string | null;
  mei: boolean | null;
  capital: string | null;
  idade_anos: number | null;
  municipio: string | null;
  uf: string | null;
  has_website: boolean | null;
  website_url: string | null;
  final_url: string | null;
  is_dead: boolean | null;
  is_https: boolean | null;
  is_link_hub: boolean | null;
  is_free_builder: boolean | null;
  has_viewport: boolean | null;
  has_contact_path: boolean | null;
  has_wa_link: boolean | null;
  has_form: boolean | null;
  platform: string | null;
  footer_year: number | null;
  psi_performance: number | null;
  title: string | null;
  email_domain: string | null;
}

/** Deterministic facts, rendered compactly. The model weighs; it does not detect. */
function renderCandidate(c: Candidate): string {
  const bits: string[] = [];
  bits.push(`cnpj: ${c.cnpj}`);
  bits.push(`nome: ${c.nome ?? "(sem nome fantasia)"}`);
  if (c.cnae) bits.push(`cnae: ${c.cnae}`);
  if (c.municipio) bits.push(`local: ${c.municipio}/${c.uf ?? ""}`);
  if (c.idade_anos !== null) bits.push(`idade: ${c.idade_anos} anos`);
  if (c.porte) bits.push(`porte: ${c.porte}`);
  if (c.mei) bits.push("MEI: sim");
  if (c.capital) bits.push(`capital social: R$ ${c.capital}`);

  if (!c.has_website) {
    // Receita has no website column. All we can say is that no site surfaced —
    // never that one does not exist. The rubric must not treat the two as equal.
    bits.push(
      c.email_domain
        ? `site: nenhum encontrado (e-mail em domínio próprio ${c.email_domain}, mas o site não respondeu)`
        : "site: NÃO ENCONTRADO — sem domínio próprio no cadastro (indício fraco, não confirmação)"
    );
  } else {
    bits.push(`site: ${c.final_url ?? c.website_url}`);
    if (c.is_dead) bits.push("site MORTO (fora do ar / erro)");
    if (c.is_free_builder) bits.push("construtor grátis (subdomínio)");

    if (c.is_link_hub) {
      // We deliberately do not fetch Instagram/Linktree, so nothing about the
      // page itself was observed. Saying "não é responsivo" here would be
      // inventing evidence from an unfetched page.
      bits.push(
        "o 'site' é só link hub (Instagram/Linktree) — NÃO abrimos a página, " +
          "então não se sabe nada sobre responsividade, formulário ou contato"
      );
    } else {
      if (c.is_https === false) bits.push("sem HTTPS (confirmado)");
      if (c.has_viewport === false) bits.push("SEM meta viewport (não responsivo no celular)");
      if (c.has_contact_path === false) bits.push("sem caminho de contato no site");
      if (c.has_wa_link) bits.push("tem link wa.me no site (já vende por WhatsApp)");
      if (c.has_form === false) bits.push("sem formulário");
    }
    if (c.platform) bits.push(`plataforma: ${c.platform}`);
    if (c.footer_year) bits.push(`rodapé © ${c.footer_year}`);
    if (c.psi_performance !== null) bits.push(`PageSpeed mobile: ${c.psi_performance}/100`);
    if (c.title) bits.push(`title: ${c.title}`);
  }

  return `- ${bits.join(" | ")}`;
}

// ------------------------------------------------------------------- runner

export interface ScoreOptions {
  limit: number;
  batchSize: number;
  rescore: boolean;
}

export async function scoreLeads(opts: ScoreOptions): Promise<void> {
  const candidates = await query<Candidate>(
    `SELECT
       l.cnpj, l.nome_fantasia AS nome, l.cnae_principal AS cnae,
       l.porte, l.opcao_mei AS mei, l.capital_social::text AS capital,
       CASE WHEN l.data_inicio_atividade IS NOT NULL
            THEN date_part('year', age(l.data_inicio_atividade))::int END AS idade_anos,
       l.municipio_nome AS municipio, l.uf,
       e.has_website, e.website_url, e.final_url, e.is_dead, e.is_https,
       e.is_link_hub, e.is_free_builder, e.has_viewport, e.has_contact_path,
       e.has_wa_link, e.has_form, e.platform, e.footer_year, e.psi_performance, e.title
     FROM leads l
     JOIN enrichment e ON e.cnpj = l.cnpj
     LEFT JOIN scores s ON s.cnpj = l.cnpj
     LEFT JOIN outreach o ON o.cnpj = l.cnpj
     LEFT JOIN suppression sup ON sup.phone_e164 = l.phone_e164
     WHERE l.phone_e164 IS NOT NULL
       AND sup.phone_e164 IS NULL
       AND o.cnpj IS NULL
       ${opts.rescore ? "" : "AND s.cnpj IS NULL"}
     -- Leads with verified site evidence first, then ones with a trade name we
     -- can actually name in a message. A lead with neither yields a generic
     -- hook, which is the thing that drives block rates.
     ORDER BY (e.has_website IS TRUE) DESC,
              l.is_mobile DESC NULLS LAST,
              (l.nome_fantasia IS NOT NULL) DESC,
              l.data_inicio_atividade DESC NULLS LAST
     LIMIT $1`,
    [opts.limit]
  );

  if (candidates.length === 0) {
    console.log("Nothing to score. Run `npm run enrich` first.");
    return;
  }

  const model = modelFor("score");
  console.log(
    `Scoring ${candidates.length} lead(s) with ${model}, ${opts.batchSize} per request...`
  );

  let scored = 0;
  let failed = 0;
  const tiers: Record<string, number> = { hot: 0, warm: 0, cold: 0 };

  for (let i = 0; i < candidates.length; i += opts.batchSize) {
    const batch = candidates.slice(i, i + opts.batchSize);
    const listing = batch.map(renderCandidate).join("\n");

    try {
      const { value } = await completeJson<{ results?: ScoreResult[] }>({
        task: "score",
        schema: SCHEMA as unknown as Record<string, unknown>,
        schemaName: "lead_scores",
        maxTokens: 400 * batch.length + 500,
        messages: [
          { role: "system", content: RUBRIC },
          {
            role: "user",
            content:
              `Avalie os ${batch.length} negócios abaixo. Responda um objeto por ` +
              `negócio, na mesma ordem, com o cnpj exato.\n\n${listing}`,
          },
        ],
      });

      // Models vary in how strictly they honour the schema wrapper: some
      // return {results:[...]}, some a bare array, some {leads:[...]}.
      const results: ScoreResult[] = Array.isArray(value)
        ? (value as ScoreResult[])
        : Array.isArray(value?.results)
          ? value.results
          : Array.isArray((value as Record<string, unknown>)?.leads)
            ? ((value as Record<string, unknown>).leads as ScoreResult[])
            : [];

      if (results.length === 0) {
        throw new LlmError(
          `Model returned JSON without a usable results array: ` +
            `${JSON.stringify(value).slice(0, 200)}`
        );
      }

      const byCnpj = new Map(
        results.filter((r) => r?.cnpj).map((r) => [String(r.cnpj).trim(), r])
      );

      for (const c of batch) {
        const r = byCnpj.get(c.cnpj);
        if (!r) {
          await recordFailure(c.cnpj, model, "model omitted this cnpj from its response");
          failed++;
          continue;
        }
        await recordScore(c.cnpj, model, r);
        scored++;
        tiers[r.tier] = (tiers[r.tier] ?? 0) + 1;
      }
    } catch (err) {
      // A batch failure marks every lead in it as failed with the real reason.
      // It never assigns a middle score — unscored must stay distinguishable.
      const msg = err instanceof LlmError ? err.message : (err as Error).message;
      for (const c of batch) {
        await recordFailure(c.cnpj, model, msg.slice(0, 400));
        failed++;
      }
      console.warn(`\n  Batch failed: ${msg.slice(0, 160)}`);
    }

    process.stdout.write(
      `\r  ${Math.min(i + opts.batchSize, candidates.length)}/${candidates.length} ` +
        `(scored ${scored}, failed ${failed})   `
    );
  }

  console.log(
    `\nDone. hot: ${tiers.hot ?? 0}, warm: ${tiers.warm ?? 0}, cold: ${tiers.cold ?? 0}, failed: ${failed}`
  );
  if (failed > 0) {
    console.log("  Failed leads have score = NULL and an error recorded — never a fake 5.");
  }
}

async function recordScore(
  cnpj: string,
  model: string,
  r: ScoreResult
): Promise<void> {
  await withClient((c) =>
    c.query(
      `INSERT INTO scores (cnpj, web_fit, chatbot_fit, confidence, tier, offer,
                           evidence, hook, model, scored_at, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), NULL)
       ON CONFLICT (cnpj) DO UPDATE SET
         web_fit = EXCLUDED.web_fit, chatbot_fit = EXCLUDED.chatbot_fit,
         confidence = EXCLUDED.confidence, tier = EXCLUDED.tier,
         offer = EXCLUDED.offer, evidence = EXCLUDED.evidence,
         hook = EXCLUDED.hook, model = EXCLUDED.model,
         scored_at = now(), error = NULL`,
      [
        cnpj,
        r.confidence === "cannot_determine" ? null : r.web_fit,
        r.confidence === "cannot_determine" ? null : r.chatbot_fit,
        r.confidence,
        r.tier,
        r.offer,
        JSON.stringify({ evidence: r.evidence, justification: r.justification }),
        r.hook,
        model,
      ]
    )
  );
}

async function recordFailure(cnpj: string, model: string, error: string): Promise<void> {
  await withClient((c) =>
    c.query(
      `INSERT INTO scores (cnpj, web_fit, chatbot_fit, model, scored_at, error)
       VALUES ($1, NULL, NULL, $2, now(), $3)
       ON CONFLICT (cnpj) DO UPDATE SET
         web_fit = NULL, chatbot_fit = NULL, model = EXCLUDED.model,
         scored_at = now(), error = EXCLUDED.error`,
      [cnpj, model, error]
    )
  );
}

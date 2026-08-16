import { createHash } from "node:crypto";
import type { OfferSpec } from "./spec";

/**
 * Composes the scoring prompt from shared guardrails plus offer-specific anchors.
 *
 * The split matters. Roughly 60% of the original hardcoded RUBRIC was not about
 * websites or chatbots at all — it was about not lying: use only the evidence
 * given, say "cannot_determine" instead of guessing, never assert something that
 * was not verified, and never claim a business lacks something merely because we
 * did not find it. That text is the reason the scores are trustworthy, and it is
 * true for every product. It lives here, unchanged, and no offer can edit it.
 *
 * What an offer supplies is only what it is selling and what a good buyer looks
 * like. That is why the dashboard lets a user edit *fields* rather than a raw
 * prompt: a free-form textarea would let someone delete the guardrails below.
 */

// --------------------------------------------------------------- guardrails

/** Epistemics: what the data can and cannot support. Product-agnostic. */
const EVIDENCE_RULES = `IMPORTANTE — os dados vêm da Receita Federal, que NÃO tem campo de site.
"site: NÃO ENCONTRADO" significa que não achamos um site, não que ele não exista.
Nesse caso use confidence "low" ou "medium", nunca "high", e não dê 5.
Nota 5 exige EVIDÊNCIA POSITIVA e verificada — nunca ausência de informação.

REGRAS:
- Baseie-se SOMENTE nas evidências fornecidas. Não invente fatos.
- Não suponha porte, faturamento, número de alunos, de clientes ou de
  funcionários: esses dados NÃO existem na base. Se a nota depender disso,
  use confidence mais baixa.
- Se as evidências forem insuficientes, use confidence "cannot_determine" e
  TODAS as notas null. É uma resposta legítima e preferível a um chute.
- Nota maior significa SEMPRE cliente melhor para quem vende. Nunca inverta.`;

/**
 * The hook rules. This is the part that decides whether a message gets a reply
 * or a block, and every clause was earned. The PROIBIDO examples stay because
 * the site check runs for every offer, so "site NÃO ENCONTRADO" appears in every
 * candidate rendering and the model must know what it may not conclude from it.
 */
const HOOK_RULES = `O campo MAIS IMPORTANTE é "hook": UMA frase em português do Brasil, informal,
que você mandaria no WhatsApp, citando um fato CONCRETO e específico daquele
negócio.

REGRA ABSOLUTA DO HOOK — nunca afirme algo que não foi verificado.
Se o dado diz "site NÃO ENCONTRADO", você NÃO sabe que eles não têm site.
Dizer "vi que vocês não têm site" é mentira e queima o contato.
Nesse caso, ou fale do que você REALMENTE sabe (ramo, cidade, tempo de
abertura), ou PERGUNTE em vez de afirmar.
  PROIBIDO: "vi que vocês não têm site"
  PROIBIDO: afirmar que eles não usam / não têm alguma coisa que não foi checada
  OK:       perguntar como fazem hoje, em vez de afirmar que não fazem

Se não houver nada específico e honesto a dizer, deixe hook null.
Um hook genérico é pior que nenhum: é ele que faz a pessoa bloquear.`;

const OUTPUT_RULES = `Responda um objeto por negócio, na mesma ordem recebida, com o cnpj exato.`;

// ----------------------------------------------------------------- composer

export function buildRubricPrompt(spec: OfferSpec): string {
  const parts: string[] = [];

  parts.push(EVIDENCE_RULES);

  parts.push(
    `Você avalia empresas brasileiras como potenciais clientes de:\n${spec.summary}\n\n` +
      `Quem decide a compra: ${spec.buyer}\n` +
      `Problema que o produto resolve: ${spec.problem}`
  );

  if (spec.stage === "presell") {
    parts.push(
      `ATENÇÃO: este produto AINDA NÃO EXISTE — está sendo validado antes de ser
construído. Avalie quem TERIA o problema e poderia pagar por uma solução, não
quem já procura um produto pronto.`
    );
  }

  for (const axis of spec.rubric.axes) {
    parts.push(
      `${axis.key} — ${axis.question}\n` +
        (["5", "4", "3", "2", "1"] as const)
          .map((lvl) => `  ${lvl} = ${axis.anchors[lvl]}`)
          .join("\n")
    );
  }

  if (spec.rubric.notes.length) {
    parts.push(`Heurísticas específicas deste produto:\n` + spec.rubric.notes.map((n) => `- ${n}`).join("\n"));
  }

  parts.push(
    `recommendation — qual caminho seguir com este lead:\n` +
      spec.rubric.recommendations.map((r) => `  "${r.value}" (${r.label}) quando ${r.when}`).join("\n")
  );

  // Offer-specific hook examples are appended AFTER the shared rules, so they
  // can add cases but never soften the prohibition above.
  const hookExtras: string[] = [];
  for (const bad of spec.rubric.hookBad) hookExtras.push(`  PROIBIDO: ${bad}`);
  for (const good of spec.rubric.hookGood) hookExtras.push(`  OK:       ${good}`);
  parts.push(hookExtras.length ? `${HOOK_RULES}\n\nPara este produto:\n${hookExtras.join("\n")}` : HOOK_RULES);

  parts.push(OUTPUT_RULES);

  return parts.join("\n\n");
}

/**
 * Builds the JSON Schema from the offer's axes.
 *
 * Called ONCE per run, before the batch loop, so the system prompt is constant
 * within a run and stays prompt-cacheable. `strict: true` on OpenRouter requires
 * every property listed in `required` and `additionalProperties: false`.
 *
 * `tier` is deliberately absent: it is a pure function of the fits and is derived
 * in TypeScript. Asking the model for it adds a failure mode and makes the
 * hot/warm/cold mapping unauditable.
 */
export function buildScoreSchema(spec: OfferSpec): Record<string, unknown> {
  const fitProps: Record<string, unknown> = {};
  for (const axis of spec.rubric.axes) {
    fitProps[axis.key] = {
      type: ["integer", "null"],
      minimum: 1,
      maximum: 5,
      description: axis.question,
    };
  }

  const properties: Record<string, unknown> = {
    cnpj: { type: "string" },
    // Justification first so generation is conditioned on the reasoning.
    justification: { type: "string" },
    ...fitProps,
    confidence: { type: "string", enum: ["high", "medium", "low", "cannot_determine"] },
    recommendation: {
      type: "string",
      enum: spec.rubric.recommendations.map((r) => r.value),
    },
    evidence: { type: "array", items: { type: "string" } },
    hook: { type: ["string", "null"] },
  };

  return {
    type: "object",
    additionalProperties: false,
    required: ["results"],
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: Object.keys(properties),
          properties,
        },
      },
    },
  };
}

/**
 * Identity of the exact prompt that produced a score. Stored on every score row
 * so "which rubric graded this lead?" has a precise answer even after the spec
 * has been edited a dozen times.
 */
export function promptSha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

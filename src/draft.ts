import { completeJson, hasApiKey } from "./llm";
import type { OfferSpec } from "./offers/spec";

export interface DraftInput {
  nome: string | null;
  municipio: string | null;
  hook: string | null;
  evidence: string[];
  /** The recommendation value the scorer chose, defined by the offer. */
  offer: string;
  spec?: OfferSpec;
}

export interface Sender {
  nome: string;
  empresa?: string;
  cnpj?: string;
}

export function sender(): Sender {
  return {
    nome: process.env.SENDER_NAME || "",
    empresa: process.env.SENDER_COMPANY || undefined,
    cnpj: process.env.SENDER_CNPJ || undefined,
  };
}

/**
 * Rules that hold for every offer. Two of them are LGPD safeguards rather than
 * copywriting — the opt-out line (LIA.md §5) and the ban on links — so they live
 * here where no offer spec can remove them.
 */
const SYSTEM_BASE = `Você escreve a PRIMEIRA mensagem de WhatsApp para uma empresa brasileira.
Regras rígidas:

1. Máximo 3 frases curtas. Isso é WhatsApp, não e-mail.
2. Comece se identificando: nome e, se houver, empresa.
3. Cite o FATO CONCRETO fornecido. Sem esse fato específico, a mensagem não presta.
4. Não prometa resultado, não invente número, não use "revolucionar", "alavancar",
   "parceria estratégica", "soluções digitais". Fale como gente.
5. Termine com uma pergunta leve e fácil de responder — não um pedido de reunião.
6. Inclua a saída: "Se não quiser receber contato meu, é só falar que eu não incomodo mais."
7. NUNCA inclua link nem imagem. Link na primeira mensagem é cara de spam.
8. Português do Brasil, informal mas respeitoso. Trate por "vocês".`;

/**
 * Pre-sell framing. The product does not exist yet, so any present-tense claim
 * about it is a lie — and a discovery question is also simply better outreach:
 * asking someone how they do something today costs them nothing to answer,
 * while a pitch from a stranger asks for money. Block rate is what kills a
 * number, and "tô construindo isso" reads as a person, not a disparo.
 */
const PRESELL_RULES = `
O produto AINDA NÃO EXISTE. Você está validando a ideia ANTES de construir.
- PROIBIDO usar presente: "temos", "nosso app faz", "já ajudamos", "nossos clientes".
- PROIBIDO citar cliente, número, resultado ou prazo. Não há nenhum.
- PROIBIDO oferecer teste, demonstração, plano ou preço — não há o que demonstrar.
- Diga com todas as letras que está construindo / pesquisando antes de construir.
- O pedido é uma OPINIÃO, não uma venda: "faz sentido pra vocês?",
  "vocês fazem isso hoje de que jeito?", "eu tô no caminho errado?".
- Uma pergunta sobre como eles resolvem isso HOJE vale mais que qualquer pitch.`;

const BETA_RULES = `
O produto existe mas está em fase inicial. Pode falar dele no presente, mas
não prometa estabilidade, resultado nem prazo, e deixe claro que é começo.`;

function systemFor(spec?: OfferSpec): string {
  if (!spec) return SYSTEM_BASE;

  const parts = [SYSTEM_BASE];
  if (spec.stage === "presell") parts.push(PRESELL_RULES);
  if (spec.stage === "beta") parts.push(BETA_RULES);

  parts.push(`\nO que você está oferecendo: ${spec.messaging.productNoun}`);
  parts.push(`Quem você quer alcançar dentro da empresa: ${spec.buyer}`);

  // For an institution the person answering the phone is a receptionist with no
  // authority. Routing to the right person beats pitching the wrong one.
  parts.push(
    `Quem atende pode não ser quem decide. Se fizer sentido, a pergunta pode ser
para quem falar, em vez de tentar convencer quem atendeu.`
  );

  if (spec.messaging.asks.length) {
    parts.push(`Exemplos de fecho:\n${spec.messaging.asks.map((a) => `- ${a}`).join("\n")}`);
  }
  if (spec.messaging.forbidden.length) {
    parts.push(
      `NUNCA afirme, para este produto:\n${spec.messaging.forbidden.map((f) => `- ${f}`).join("\n")}`
    );
  }
  return parts.join("\n");
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: { message: { type: "string" } },
};

/** Deterministic fallback so the queue works with no LLM key or on failure. */
export function templateDraft(input: DraftInput, s: Sender): string {
  const quem = s.empresa ? `${s.nome} da ${s.empresa}` : s.nome || "eu";
  const papel = input.spec?.messaging.senderRole ?? "sou desenvolvedor";
  const fato = input.hook ?? input.evidence[0] ?? "dei uma olhada no perfil de vocês";
  const ask = input.spec?.messaging.fallbackAsk ?? "Faz sentido eu te mostrar como dá pra arrumar isso?";

  return (
    `Oi! Aqui é ${quem}, ${papel}. ` +
    `${fato.charAt(0).toUpperCase()}${fato.slice(1)}. ` +
    `${ask} ` +
    `Se não quiser receber contato meu, é só falar que eu não incomodo mais.`
  );
}

export async function draftMessage(input: DraftInput): Promise<string> {
  const s = sender();

  // Without a concrete fact the message would be generic, which is exactly
  // what drives block rates. Fall back rather than generate filler.
  if (!hasApiKey() || !input.hook) {
    return templateDraft(input, s);
  }

  try {
    const { value } = await completeJson<{ message: string }>({
      task: "draft",
      schema: SCHEMA,
      schemaName: "whatsapp_opener",
      temperature: 0.6,
      maxTokens: 400,
      messages: [
        { role: "system", content: systemFor(input.spec) },
        {
          role: "user",
          content:
            `Remetente: ${s.nome || "(nome não configurado)"}` +
            (s.empresa ? ` — ${s.empresa}` : "") +
            (s.cnpj ? ` — CNPJ ${s.cnpj}` : "") +
            `\nNegócio: ${input.nome ?? "(sem nome)"}` +
            (input.municipio ? ` — ${input.municipio}` : "") +
            `\nRecomendação do scorer: ${input.offer}` +
            `\nFATO CONCRETO (use este): ${input.hook}` +
            `\nOutras evidências: ${input.evidence.join("; ") || "(nenhuma)"}`,
        },
      ],
    });

    const msg = value.message?.trim();
    return msg && msg.length > 20 ? msg : templateDraft(input, s);
  } catch {
    return templateDraft(input, s);
  }
}

export function waMeLink(e164: string): string {
  return `https://wa.me/${e164.replace(/\D/g, "")}`;
}

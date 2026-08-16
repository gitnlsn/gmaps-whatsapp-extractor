import { completeJson, hasApiKey } from "./llm";

export interface DraftInput {
  nome: string | null;
  municipio: string | null;
  hook: string | null;
  evidence: string[];
  offer: string; // site | chatbot | both | none
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

const SYSTEM = `Você escreve a PRIMEIRA mensagem de WhatsApp de um desenvolvedor brasileiro
para um pequeno negócio local. Regras rígidas:

1. Máximo 3 frases curtas. Isso é WhatsApp, não e-mail.
2. Comece se identificando: nome e, se houver, empresa.
3. Cite o FATO CONCRETO fornecido. Sem esse fato específico, a mensagem não presta.
4. Não prometa resultado, não invente número, não use "revolucionar", "alavancar",
   "parceria estratégica", "soluções digitais". Fale como gente.
5. Termine com uma pergunta leve e fácil de responder — não um pedido de reunião.
6. Inclua a saída: "Se não quiser receber contato meu, é só falar que eu não incomodo mais."
7. NUNCA inclua link nem imagem. Link na primeira mensagem é cara de spam.
8. Português do Brasil, informal mas respeitoso. Trate por "vocês".`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["message"],
  properties: { message: { type: "string" } },
};

/** Deterministic fallback so the queue works with no LLM key or on failure. */
export function templateDraft(input: DraftInput, s: Sender): string {
  const quem = s.empresa ? `${s.nome} da ${s.empresa}` : s.nome || "eu";
  const fato = input.hook ?? input.evidence[0] ?? "dei uma olhada na presença digital de vocês";
  const oferta =
    input.offer === "chatbot"
      ? "automatizar o atendimento de vocês no WhatsApp"
      : input.offer === "both"
        ? "resolver isso"
        : "arrumar isso";

  return (
    `Oi! Aqui é ${quem}, sou desenvolvedor. ` +
    `${fato.charAt(0).toUpperCase()}${fato.slice(1)}. ` +
    `Faz sentido eu te mostrar como dá pra ${oferta}? ` +
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
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content:
            `Remetente: ${s.nome || "(nome não configurado)"}` +
            (s.empresa ? ` — ${s.empresa}` : "") +
            (s.cnpj ? ` — CNPJ ${s.cnpj}` : "") +
            `\nNegócio: ${input.nome ?? "(sem nome)"}` +
            (input.municipio ? ` — ${input.municipio}` : "") +
            `\nProduto a oferecer: ${input.offer}` +
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

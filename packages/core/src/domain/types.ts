export interface Lead {
  cnpj: string;
  razaoSocial: string | null;
  nomeFantasia: string | null;
  cnaePrincipal: string | null;
  porte: string | null;
  capitalSocial: string | null;
  opcaoMei: boolean | null;
  dataInicioAtividade: string | null;
  situacao: string;
  uf: string | null;
  municipioId: number | null;
  municipioNome: string | null;
  phoneE164: string | null;
  isMobile: boolean | null;
  email: string | null;
  googlePlaceId: string | null;
  source: string;
  collectedAt: string;
}

export type Tier = "hot" | "warm" | "cold";
export type Offer = "site" | "chatbot" | "both" | "none";
export type Confidence = "high" | "medium" | "low" | "cannot_determine";
export type OutreachStatus =
  | "queued"
  | "sent"
  | "replied"
  | "not_a_fit"
  | "opted_out";

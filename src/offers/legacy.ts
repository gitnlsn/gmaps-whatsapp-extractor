import type { OfferSpec } from "./spec";

/**
 * The original offer — website + WhatsApp automation for micro-businesses —
 * expressed as an OfferSpec instead of a hardcoded prompt.
 *
 * It exists for two reasons. It is the backfill target for every score written
 * before offers existed, so no historical row is orphaned. And it is the
 * equivalence test for the refactor: the prompt this spec composes should say
 * the same things the old `RUBRIC` constant in src/score.ts said, which is how
 * we know the extraction did not quietly change the rubric.
 *
 * The anchors below are lifted from that constant verbatim.
 */
export const LEGACY_OFFER_ID = "site-chatbot";

export const LEGACY_SPEC: OfferSpec = {
  schemaVersion: 1,
  stage: "live",
  summary:
    "um desenvolvedor solo que vende duas coisas: (A) SITE / LANDING PAGE e " +
    "(B) AUTOMAÇÃO DE WHATSAPP / CHATBOT de atendimento, para pequenos negócios brasileiros",
  buyer: "o próprio dono do negócio — em micronegócio quem atende o telefone decide",
  problem:
    "presença digital fraca (sem site, site morto, só Linktree, não abre no celular) " +
    "e atendimento manual no WhatsApp sem nenhuma automação",

  targeting: {
    cnaePrefixes: ["5611", "9602", "8630", "4520", "9313", "4712"],
    cnaeExclude: [],
    // The original pipeline was mobile-only: the channel was cold WhatsApp to a
    // micro-business owner's personal cell.
    channels: ["mobile"],
    ufs: [],
    naturezaPrefixes: [],
    porteIn: [],
    minCapitalSocial: null,
    excludeMei: false,
    minAgeYears: null,
    maxAgeYears: null,
    requireNomeFantasia: false,
  },

  probes: [],

  ranking: {
    cnaeExact: 0,
    naturezaPrivada: 0,
    channelMobile: 1,
    porteMatch: 0,
    ageMatch: 1,
    capitalBand: 0,
    hasNomeFantasia: 2,
    hasWebsite: 2,
    ownDomain: 1,
    probeHit: 0,
    ftsTerms: [],
    ftsWeight: 0,
  },

  rubric: {
    axes: [
      {
        key: "web_fit",
        label: "site",
        question: "quanto ele precisa de um SITE",
        anchors: {
          "5":
            "verificamos e o site está morto/404, OU o \"site\" é só Linktree/Instagram. " +
            "Evidência concreta, não ausência de informação.",
          "4":
            "tem site mas em construtor grátis (wixsite.com, negocio.site, business.site, " +
            "wordpress.com) ou sem HTTPS, ou sem meta viewport (não abre direito no celular).",
          "3":
            "tem site funcional mas parado: rodapé com ano <= 2021, sem formulário, sem " +
            "caminho de contato. (Nenhum site encontrado e sem domínio próprio também cai " +
            "aqui ou em 4, mas é indício, não prova — use confidence low/medium.)",
          "2": "site funcional e razoável, só daria para melhorar.",
          "1": "site moderno, rápido, responsivo, com contato claro. Não é cliente.",
        },
      },
      {
        key: "chatbot_fit",
        label: "chatbot",
        question: "quanto ele precisa de AUTOMAÇÃO DE ATENDIMENTO",
        anchors: {
          "5":
            "já vende por WhatsApp (link wa.me no site/bio) e não tem nenhum sistema de " +
            "agendamento ou formulário. Volume alto de clientes.",
          "4":
            "negócio de atendimento (clínica, salão, barbearia, oficina, restaurante, pet shop) " +
            "sem nenhum caminho de contato automatizado no site.",
          "3": "tem formulário ou telefone, mas nada de agendamento/automação.",
          "2": "já tem algum sistema de agendamento ou atendimento estruturado.",
          "1": "empresa sem atendimento ao público, ou já totalmente automatizada.",
        },
      },
    ],
    recommendations: [
      { value: "site", label: "site", when: "só o web_fit é alto" },
      { value: "chatbot", label: "chatbot", when: "só o chatbot_fit é alto" },
      { value: "both", label: "ambos", when: "as duas notas são altas" },
      { value: "none", label: "não é cliente", when: "nenhuma das duas é alta" },
    ],
    notes: [
      "Empresa muito nova (< 2 anos) tende a precisar mais de site.",
      "MEI e capital social baixo = ticket menor, mas ainda cliente.",
    ],
    hookBad: [
      '"vi que vocês ainda não têm sistema de agendamento"',
    ],
    hookGood: [
      '"vi que a barbearia abriu esse ano aqui em Juiz de Fora — vocês já têm site ou tá tudo no Instagram por enquanto?"',
      '"procurei a lanchonete no Google e não achei site de vocês — é proposital ou ainda tá na lista?"',
      '"vi que o site de vocês tá no ar mas não abre direito no celular"',
      '"o link de vocês leva pro Linktree — quem procura no Google não acha"',
      '"o site de vocês tá fora do ar (dá erro 404)"',
    ],
    siteSignals: "full",
  },

  messaging: {
    senderRole: "sou desenvolvedor",
    productNoun: "site e automação de atendimento no WhatsApp",
    goal: "sell",
    asks: ["Faz sentido eu te mostrar como dá pra arrumar isso?"],
    fallbackAsk: "Faz sentido eu te mostrar como dá pra arrumar isso?",
    forbidden: [],
  },

  presets: [
    { label: "🔥 hot", query: "tier=hot" },
    { label: "sem site", query: "site=none" },
    { label: "site morto", query: "site=dead" },
    { label: "só Instagram/Linktree", query: "site=hub" },
    { label: "não abre no celular", query: "site=noviewport&minFit=4" },
    { label: "empresa nova (≤2 anos)", query: "maxIdade=2" },
  ],
};

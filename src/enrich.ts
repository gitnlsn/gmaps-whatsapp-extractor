import { query, withClient } from "./db";

/** Hosts that mean "they have no real website, just a link in bio". */
const LINK_HUBS = [
  "linktr.ee",
  "linktree.com",
  "beacons.ai",
  "bio.link",
  "linkbio.co",
  "lnk.bio",
  "campsite.bio",
  "linkme.bio",
  "instagram.com",
  "facebook.com",
  "fb.com",
  "m.facebook.com",
  "wa.me",
  "api.whatsapp.com",
  "chat.whatsapp.com",
  "youtube.com",
  "tiktok.com",
];

/** Free-subdomain builders — a strong "cheap or abandoned site" signal. */
const FREE_BUILDERS = [
  ".wixsite.com",
  ".negocio.site", // Google's free BR site builder
  ".business.site", // deprecated 2024 → these are usually dead
  ".wordpress.com",
  ".blogspot.com",
  ".webnode.page",
  ".webnode.com.br",
  ".weebly.com",
  ".jimdosite.com",
  ".godaddysites.com",
  ".mystrikingly.com",
];

/**
 * Free/consumer mail providers. An address at one of these tells us nothing
 * about a website; an address at any other domain usually IS their domain.
 */
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.com.br", "outlook.com",
  "outlook.com.br", "live.com", "msn.com", "yahoo.com", "yahoo.com.br",
  "ymail.com", "icloud.com", "me.com", "aol.com", "protonmail.com", "proton.me",
  "uol.com.br", "bol.com.br", "terra.com.br", "ig.com.br", "globo.com",
  "globomail.com", "r7.com", "oi.com.br", "zipmail.com.br", "superig.com.br",
  "brturbo.com.br", "pop.com.br", "click21.com.br", "veloxmail.com.br",
]);

/**
 * Receita Federal publishes no website column, so a lead with no site recorded
 * is "unknown", not "has none". The registered e-mail domain closes most of
 * that gap for free: a business that registered contato@suapadaria.com.br owns
 * suapadaria.com.br. Consumer-provider addresses are ignored.
 */
/**
 * Mistyped consumer providers. These resolve to parking or spam pages and
 * would otherwise be scored as though the business owned the domain.
 */
const TYPO_MAIL = /^(gmai|gmial|gmail|hotmai|hotmial|outlok|yaho|uol|bol|terra|ig|globo)\.(com|com\.br)$/;

/** Brazilian accounting-office markers — the classic wrong attribution. */
const ACCOUNTANT = /(^|[.-])(contab|contabil|contabilidade|assessoria|escritorio|escrit|conta[bd]|fiscal|tributa)/;

export function websiteFromEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return null;

  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain || !domain.includes(".") || domain.length < 5) return null;
  if (FREE_MAIL.has(domain) || TYPO_MAIL.test(domain)) return null;
  if (domain.endsWith(".gov.br")) return null;

  // .cnt.br is Brazil's reserved TLD for accountants, and an accounting office
  // registering the CNPJ puts its own address in the record.
  if (domain.endsWith(".cnt.br") || ACCOUNTANT.test(domain)) return null;

  return `https://${domain}`;
}

export interface SiteSignals {
  websiteUrl: string | null;
  finalUrl: string | null;
  httpStatus: number | null;
  error: string | null;
  hasWebsite: boolean;
  isDead: boolean;
  isHttps: boolean;
  isLinkHub: boolean;
  isFreeBuilder: boolean;
  // null = we never fetched the page, so this is unknown rather than false.
  // A link hub is short-circuited on purpose, and a default of `false` would
  // be read downstream as observed evidence ("not mobile-friendly").
  hasViewport: boolean | null;
  hasContactPath: boolean | null;
  hasWaLink: boolean | null;
  hasForm: boolean | null;
  generator: string | null;
  platform: string | null;
  footerYear: number | null;
  title: string | null;
  igHandle: string | null;
  /** Filled only when --psi is passed; PageSpeed is a separate API call. */
  psiPerformance: number | null;
}

function emptySignals(url: string | null): SiteSignals {
  return {
    websiteUrl: url,
    finalUrl: null,
    httpStatus: null,
    error: null,
    hasWebsite: Boolean(url),
    isDead: false,
    isHttps: false,
    isLinkHub: false,
    isFreeBuilder: false,
    hasViewport: null,
    hasContactPath: null,
    hasWaLink: null,
    hasForm: null,
    generator: null,
    platform: null,
    footerYear: null,
    title: null,
    igHandle: null,
    psiPerformance: null,
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function detectPlatform(html: string, generator: string | null): string | null {
  const h = html.toLowerCase();
  if (generator) {
    const g = generator.toLowerCase();
    if (g.includes("wordpress")) return "wordpress";
    if (g.includes("wix")) return "wix";
    if (g.includes("joomla")) return "joomla";
    if (g.includes("drupal")) return "drupal";
  }
  if (h.includes("/wp-content/") || h.includes("/wp-includes/")) return "wordpress";
  if (h.includes("static.parastorage.com") || h.includes("wix.com")) return "wix";
  if (h.includes("squarespace")) return "squarespace";
  if (h.includes("shopify")) return "shopify";
  if (h.includes("cdn.jsdelivr.net/npm/vue") || h.includes("__nuxt")) return "vue";
  if (h.includes("__next")) return "nextjs";
  return null;
}

/** Analyzes already-fetched HTML. Split out so it is unit-testable without network. */
export function analyzeHtml(html: string, finalUrl: string): Partial<SiteSignals> {
  const head = html.slice(0, 200_000); // enough for meta tags on any real page
  const lower = head.toLowerCase();

  const generatorMatch = head.match(
    /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i
  );
  const titleMatch = head.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);

  // Copyright years across the whole document; take the most recent.
  const years = [...html.matchAll(/(?:©|&copy;|copyright)[^0-9]{0,20}(20\d{2})/gi)]
    .map((m) => Number(m[1]))
    .filter((y) => y >= 2000 && y <= 2100);

  const igMatch = html.match(
    /(?:instagram\.com\/)([A-Za-z0-9_.]{2,30})(?:[/?"'\s]|$)/i
  );

  const generator = generatorMatch?.[1]?.trim() ?? null;

  return {
    hasViewport: /<meta[^>]+name=["']viewport["']/i.test(head),
    hasWaLink: /(?:wa\.me\/|api\.whatsapp\.com\/send|whatsapp:\/\/send)/i.test(html),
    hasContactPath:
      /href=["']tel:/i.test(html) ||
      /(?:wa\.me\/|api\.whatsapp\.com\/send)/i.test(html) ||
      /href=["']mailto:/i.test(html) ||
      /\b(agendar|agendamento|marcar hor[áa]rio|reservar|fale conosco|contato)\b/i.test(
        lower
      ),
    hasForm: /<form[\s>]/i.test(html),
    generator,
    platform: detectPlatform(html, generator),
    footerYear: years.length ? Math.max(...years) : null,
    title: titleMatch?.[1]?.replace(/\s+/g, " ").trim().slice(0, 200) ?? null,
    igHandle: igMatch && !["p", "reel", "explore"].includes(igMatch[1]) ? igMatch[1] : null,
    isHttps: finalUrl.startsWith("https://"),
  };
}

export async function checkSite(rawUrl: string | null, timeoutMs = 8000): Promise<SiteSignals> {
  const signals = emptySignals(rawUrl);
  if (!rawUrl) return signals;

  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

  const host = hostOf(url);
  signals.isLinkHub = LINK_HUBS.some((h) => host === h || host.endsWith(`.${h}`));
  signals.isFreeBuilder = FREE_BUILDERS.some((s) => host.endsWith(s));

  // A link hub is already a conclusive answer for the website pitch — no need
  // to fetch Instagram. Page-level signals stay null: we did not look.
  if (signals.isLinkHub) {
    signals.finalUrl = url;
    signals.hasWebsite = true;
    const m = url.match(/instagram\.com\/([A-Za-z0-9_.]{2,30})/i);
    if (m) signals.igHandle = m[1];
    return signals;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "pt-BR,pt;q=0.9",
      },
    });

    signals.httpStatus = res.status;
    signals.finalUrl = res.url || url;
    signals.isDead = res.status >= 400;

    // The redirect target may itself be a link hub (very common in Brazil).
    const finalHost = hostOf(signals.finalUrl);
    if (LINK_HUBS.some((h) => finalHost === h || finalHost.endsWith(`.${h}`))) {
      signals.isLinkHub = true;
    }
    if (FREE_BUILDERS.some((s) => finalHost.endsWith(s))) {
      signals.isFreeBuilder = true;
    }

    if (res.ok) {
      const html = await res.text();
      Object.assign(signals, analyzeHtml(html, signals.finalUrl));
    } else {
      signals.isHttps = signals.finalUrl.startsWith("https://");
    }
  } catch (err) {
    const e = err as Error;
    signals.isDead = true;
    signals.error = e.name === "AbortError" ? "timeout" : e.message.slice(0, 200);
  } finally {
    clearTimeout(timer);
  }

  return signals;
}

// ---------------------------------------------------- PageSpeed Insights API
// 25,000 requests/day free, no key or billing required.

export async function pageSpeed(url: string): Promise<number | null> {
  const params = new URLSearchParams({ url, strategy: "mobile", category: "performance" });
  const key = process.env.PAGESPEED_API_KEY;
  if (key) params.set("key", key);

  try {
    const res = await fetch(
      `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      lighthouseResult?: { categories?: { performance?: { score?: number } } };
    };
    const score = data.lighthouseResult?.categories?.performance?.score;
    return typeof score === "number" ? Math.round(score * 100) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- runner

export interface EnrichOptions {
  limit: number;
  concurrency: number;
  psi: boolean;
  recheck: boolean;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });

  await Promise.all(workers);
  return results;
}

export async function enrichLeads(opts: EnrichOptions): Promise<void> {
  // Only contactable leads are worth spending requests on.
  //
  // The shared_domains CTE is the important part: an e-mail domain used by
  // several different CNPJs belongs to an accountant, a franchise head office
  // or a business-services portal — never to the individual business. Pattern
  // lists miss these; counting catches them all.
  const rows = await query<{ cnpj: string; website: string | null; email: string | null }>(
    `WITH shared_domains AS (
       SELECT split_part(email, '@', 2) AS domain
       FROM leads
       WHERE email IS NOT NULL AND email <> ''
       GROUP BY 1
       HAVING count(DISTINCT cnpj) > 2
     )
     SELECT l.cnpj, e.website_url AS website,
            CASE WHEN sd.domain IS NULL THEN l.email END AS email
     FROM leads l
     LEFT JOIN enrichment e ON e.cnpj = l.cnpj
     LEFT JOIN shared_domains sd ON sd.domain = split_part(l.email, '@', 2)
     WHERE l.phone_e164 IS NOT NULL
       AND l.situacao = 'ATIVA'
       ${opts.recheck ? "" : "AND e.cnpj IS NULL"}
     -- Mobiles first: they are reachable on WhatsApp, so they are worth
     -- enriching before landlines. But a landline is a *maybe*, not a no —
     -- institutions (schools, faculdades) register fixed lines and many run
     -- WhatsApp Business on them, so they must not be filtered out entirely.
     ORDER BY l.is_mobile DESC NULLS LAST,
              l.data_inicio_atividade DESC NULLS LAST
     LIMIT $1`,
    [opts.limit]
  );

  if (rows.length === 0) {
    console.log("Nothing to enrich. (Leads need a phone number.)");
    return;
  }

  console.log(`Enriching ${rows.length} lead(s), concurrency ${opts.concurrency}...`);
  let done = 0;
  let noSite = 0;
  let dead = 0;
  let hub = 0;

  await mapLimit(rows, opts.concurrency, async (row) => {
    const candidate = row.website ?? websiteFromEmail(row.email);
    const signals = await checkSite(candidate);

    if (opts.psi && signals.finalUrl && !signals.isDead && !signals.isLinkHub) {
      signals.psiPerformance = await pageSpeed(signals.finalUrl);
    }

    await upsertEnrichment(row.cnpj, signals);

    done++;
    if (!signals.hasWebsite) noSite++;
    if (signals.isDead) dead++;
    if (signals.isLinkHub) hub++;
    if (done % 25 === 0 || done === rows.length) {
      process.stdout.write(`\r  ${done}/${rows.length}   `);
    }
  });

  console.log(
    `\nDone. no site: ${noSite}, dead: ${dead}, link-hub: ${hub}, ok: ${
      rows.length - noSite - dead - hub
    }`
  );
}

export async function upsertEnrichment(cnpj: string, s: SiteSignals): Promise<void> {
  await withClient((c) =>
    c.query(
      `INSERT INTO enrichment (
         cnpj, checked_at, website_url, final_url, http_status, error,
         has_website, is_dead, is_https, is_link_hub, is_free_builder,
         has_viewport, has_contact_path, has_wa_link, has_form,
         generator, platform, footer_year, title, ig_handle, psi_performance
       ) VALUES (
         $1, now(), $2, $3, $4, $5,
         $6, $7, $8, $9, $10,
         $11, $12, $13, $14,
         $15, $16, $17, $18, $19, $20
       )
       ON CONFLICT (cnpj) DO UPDATE SET
         checked_at = now(), website_url = EXCLUDED.website_url,
         final_url = EXCLUDED.final_url, http_status = EXCLUDED.http_status,
         error = EXCLUDED.error, has_website = EXCLUDED.has_website,
         is_dead = EXCLUDED.is_dead, is_https = EXCLUDED.is_https,
         is_link_hub = EXCLUDED.is_link_hub, is_free_builder = EXCLUDED.is_free_builder,
         has_viewport = EXCLUDED.has_viewport, has_contact_path = EXCLUDED.has_contact_path,
         has_wa_link = EXCLUDED.has_wa_link, has_form = EXCLUDED.has_form,
         generator = EXCLUDED.generator, platform = EXCLUDED.platform,
         footer_year = EXCLUDED.footer_year, title = EXCLUDED.title,
         ig_handle = EXCLUDED.ig_handle,
         psi_performance = COALESCE(EXCLUDED.psi_performance, enrichment.psi_performance)`,
      [
        cnpj,
        s.websiteUrl,
        s.finalUrl,
        s.httpStatus,
        s.error,
        s.hasWebsite,
        s.isDead,
        s.isHttps,
        s.isLinkHub,
        s.isFreeBuilder,
        s.hasViewport,
        s.hasContactPath,
        s.hasWaLink,
        s.hasForm,
        s.generator,
        s.platform,
        s.footerYear,
        s.title,
        s.igHandle,
        s.psiPerformance,
      ]
    )
  );
}

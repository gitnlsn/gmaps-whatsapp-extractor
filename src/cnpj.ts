import puppeteer, { type Page } from "puppeteer";
import { CnpjCompany } from "./types";

const BASE_URL = "https://basecnpj.com.br";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function buildListUrl(pageNumber: number, cnae?: string): string {
  let url = `${BASE_URL}/resultado?page=${pageNumber}&localizacao=SP-São+Paulo&porte=1&capitalSocial=0;50000&opcaoMei=Sim&cnaeSecundario=1&tipoEmpresa=Matriz&tipoDados=lista`;
  if (cnae) url += `&cnae=${cnae}`;
  return url;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function scrapeListPage(
  page: Page,
  pageNumber: number,
  verbose = false,
  cnae?: string
): Promise<CnpjCompany[]> {
  const url = buildListUrl(pageNumber, cnae);
  if (verbose) console.log(`  [verbose] Navigating to: ${url}`);
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  if (verbose) console.log(`  [verbose] Page loaded, waiting for list items...`);

  // Wait for the list container to render (JS-driven page)
  try {
    await page.waitForSelector('[class*="item"] h4', { timeout: 10000 });
    if (verbose) console.log(`  [verbose] List items found`);
  } catch {
    if (verbose) {
      console.log(`  [verbose] No list items found, dumping page title and URL`);
      console.log(`  [verbose] Title: ${await page.title()}`);
      console.log(`  [verbose] URL: ${page.url()}`);
    }
    return [];
  }

  const companies = await page.evaluate(() => {
    const items = document.querySelectorAll(
      '[class*="style-module-scss-module"][class*="item"]'
    );
    const results: {
      status: string;
      companyName: string;
      cnpj: string;
      location: string;
      detailUrl: string;
    }[] = [];

    items.forEach((item) => {
      const statusEl = item.querySelector(
        '[class*="status"] span'
      );
      const h4 = item.querySelector("h4");
      const tagSpan = item.querySelector('[class*="tag"] span');
      const link = item.querySelector("a.btn") as HTMLAnchorElement | null;

      const status = statusEl?.textContent?.trim() ?? "";
      const h4Text = h4?.textContent?.trim() ?? "";

      // h4 contains "Company Name - 65.142.103" or similar
      const cnpjMatch = h4Text.match(/[\d.]+$/);
      const cnpj = cnpjMatch ? cnpjMatch[0] : "";
      const companyName = cnpj
        ? h4Text.replace(/\s*-?\s*[\d.]+$/, "").trim()
        : h4Text;

      const location = tagSpan?.textContent?.trim() ?? "";
      const href = link?.getAttribute("href") ?? "";
      const detailUrl = href
        ? `https://basecnpj.com.br${href}`
        : "";

      if (companyName) {
        results.push({ status, companyName, cnpj, location, detailUrl });
      }
    });

    return results;
  });

  return companies;
}

function extractField(html: string, label: string): string {
  // Match the basecnpj.com.br detail page structure:
  // <div class="...item...cell...">
  //   <span class="...label...">LABEL</span>
  //   <span class="...value...">VALUE (may contain nested tags)</span>
  // </div>
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Find the label, then capture everything up to the closing </div> of the item
  const pattern = new RegExp(
    `>${escapedLabel}</span>\\s*<span[^>]*class="[^"]*value[^"]*"[^>]*>([\\s\\S]*?)</div>`,
    "i"
  );
  const match = html.match(pattern);
  if (match?.[1]) {
    // Remove the trailing </span> and any tags after it, strip inner HTML tags
    let value = match[1];
    // Cut at the last </span> that closes the value span
    const lastSpanClose = value.lastIndexOf("</span>");
    if (lastSpanClose !== -1) {
      value = value.substring(0, lastSpanClose);
    }
    return value
      .replace(/<[^>]+>/g, " ")
      .replace(/\s*Mais empresas deste CEP\s*/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  return "";
}

export async function scrapeDetailPage(
  page: Page,
  company: CnpjCompany,
  verbose = false
): Promise<CnpjCompany> {
  if (!company.detailUrl) return company;

  try {
    // Use domcontentloaded since the site's JS crashes in headless mode
    if (verbose) console.log(`    [verbose] Navigating to: ${company.detailUrl}`);
    await page.goto(company.detailUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    // Give SSR content time to be in the DOM
    await sleep(2000);

    // Parse raw HTML instead of page.evaluate() to avoid site JS errors
    const html = await page.content();
    if (verbose) {
      console.log(`    [verbose] Page HTML length: ${html.length} chars`);
      for (const label of ["CNPJ", "Razão Social", "Nome Fantasia", "CNAE Principal", "Endereço", "Natureza Jurídica"]) {
        const idx = html.indexOf(label);
        if (idx !== -1) {
          console.log(`    [verbose] Found "${label}" at index ${idx}: ...${html.substring(idx, idx + 300)}...`);
        } else {
          console.log(`    [verbose] "${label}" NOT found in HTML`);
        }
      }
    }

    const razaoSocial = extractField(html, "Razão Social");
    const capitalSocial = extractField(html, "Capital Social");
    const cnaePrincipal = extractField(html, "CNAE Principal");
    const dataAbertura =
      extractField(html, "Data de Abertura") ||
      extractField(html, "Abertura");
    const nomeFantasia = extractField(html, "Nome Fantasia");
    const naturezaJuridica = extractField(html, "Natureza Jurídica");
    const endereco = extractField(html, "Endereço");
    const cnaesSecundarios = extractField(html, "CNAES Secundários");
    const cnpjFull = extractField(html, "CNPJ");

    return {
      ...company,
      razaoSocial: razaoSocial || undefined,
      capitalSocial: capitalSocial || undefined,
      cnaePrincipal: cnaePrincipal || undefined,
      dataAbertura: dataAbertura || undefined,
      nomeFantasia: nomeFantasia || undefined,
      naturezaJuridica: naturezaJuridica || undefined,
      endereco: endereco || undefined,
      cnaesSecundarios: cnaesSecundarios || undefined,
      cnpjFull: cnpjFull || undefined,
    };
  } catch (err) {
    console.warn(
      `Warning: Failed to scrape details for ${company.companyName}: ${(err as Error).message}`
    );
    return company;
  }
}

export interface ScrapeOptions {
  pages: number;
  details: boolean;
  headless: boolean;
  verbose: boolean;
  cnae?: string;
}

export async function scrapeAllPages(
  options: ScrapeOptions
): Promise<CnpjCompany[]> {
  const browser = await puppeteer.launch({
    headless: options.headless,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 800 });

    const allCompanies: CnpjCompany[] = [];

    for (let i = 1; i <= options.pages; i++) {
      console.log(`Scraping page ${i}/${options.pages}...`);
      const companies = await scrapeListPage(page, i, options.verbose, options.cnae);

      if (companies.length === 0) {
        console.log(`No results on page ${i}. Stopping.`);
        break;
      }

      console.log(`  Found ${companies.length} companies`);
      allCompanies.push(...companies);

      if (i < options.pages) {
        await sleep(2000);
      }
    }

    if (options.details && allCompanies.length > 0) {
      console.log(`\nFetching details for ${allCompanies.length} companies...`);
      for (let i = 0; i < allCompanies.length; i++) {
        console.log(
          `  Detail ${i + 1}/${allCompanies.length}: ${allCompanies[i].companyName}`
        );
        allCompanies[i] = await scrapeDetailPage(page, allCompanies[i], options.verbose);
        if (i < allCompanies.length - 1) {
          await sleep(1500);
        }
      }
    }

    return allCompanies;
  } finally {
    await browser.close();
  }
}

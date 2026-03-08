import { config } from "dotenv";
import { Command } from "commander";
import { textSearch, getPlaceDetails } from "./places";
import { classifyPhone, buildWaMeLink } from "./phone";
import { writeCsv, writeCnpjCsv, writeCnpjJson } from "./csv";
import { scoreLeads } from "./gemini";
import { scrapeAllPages } from "./cnpj";
import { ExtractedContact, PlaceTextSearchResult } from "./types";

config();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const program = new Command();
program
  .name("gmaps-whatsapp-extractor")
  .description("Extract WhatsApp links from Google Maps and scrape CNPJ data");

// --- gmaps subcommand ---
program
  .command("gmaps")
  .description("Extract WhatsApp links from Google Maps search results")
  .argument("<query>", "Google Maps search query")
  .option("-o, --output <file>", "CSV output file path")
  .option("-c, --country <code>", "Default country code for phone parsing (e.g. BR)")
  .option("-l, --limit <n>", "Max results to process", "60")
  .option("--score", "Score leads using Gemini AI")
  .option("--no-website", "Only include businesses without a website")
  .action(async (query: string, opts: {
    output?: string;
    country?: string;
    limit: string;
    score?: boolean;
    website?: boolean;
  }) => {
    const limit = parseInt(opts.limit, 10);
    const noWebsite = opts.website === false;

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      console.error("Error: GOOGLE_MAPS_API_KEY not set. Create a .env file or set the environment variable.");
      process.exit(1);
    }

    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (opts.score && !geminiApiKey) {
      console.error("Error: GEMINI_API_KEY not set. Required when using --score flag.");
      process.exit(1);
    }

    console.log(`Searching for "${query}"...`);
    const places: PlaceTextSearchResult[] = [];

    for await (const batch of textSearch(query, apiKey)) {
      for (const place of batch) {
        places.push(place);
        if (places.length >= limit) break;
      }
      if (places.length >= limit) break;
    }

    console.log(`Found ${places.length} places. Fetching details...`);

    let contacts: ExtractedContact[] = [];
    let withPhone = 0;

    for (const place of places) {
      const details = await getPlaceDetails(place.name, apiKey);

      if (details.internationalPhoneNumber) {
        withPhone++;
        const result = classifyPhone(details.internationalPhoneNumber, opts.country);

        if (result && result.isMobile) {
          if (noWebsite && details.websiteUri) {
            continue;
          }

          const waMeLink = buildWaMeLink(result.e164);
          contacts.push({
            name: details.displayName.text,
            phone: result.e164,
            waMeLink,
            address: details.formattedAddress,
            websiteUri: details.websiteUri,
            rating: details.rating,
            userRatingCount: details.userRatingCount,
            primaryType: details.primaryType,
            googleMapsUri: details.googleMapsUri,
          });
          console.log(`${details.displayName.text}: ${waMeLink}`);
        }
      }

      await sleep(200);
    }

    if (opts.score && geminiApiKey && contacts.length > 0) {
      console.log(`\nScoring ${contacts.length} leads with Gemini...`);
      contacts = await scoreLeads(contacts, geminiApiKey);

      console.log("\n--- Lead Scores ---");
      for (const c of contacts) {
        console.log(`[${c.leadScore}/10] ${c.name} — ${c.leadScoreReason}`);
      }
    }

    if (opts.output) {
      await writeCsv(opts.output, contacts);
      console.log(`\nCSV written to ${opts.output}`);
    }

    console.log(`\nSummary: Found ${places.length} places, ${withPhone} had phones, ${contacts.length} were mobile`);
  });

// --- cnpj subcommand ---
program
  .command("cnpj")
  .description("Scrape MEI company data from basecnpj.com.br")
  .option("-o, --output <file>", "CSV output file path")
  .option("-p, --pages <n>", "Number of pages to scrape", "1")
  .option("--details", "Visit detail pages for extra info")
  .option("--no-headless", "Show browser window for debugging")
  .option("--verbose", "Print detailed debug logs")
  .option("--cnae <code>", "Filter by CNAE code (e.g. 5611201 for restaurants)")
  .action(async (opts: {
    output?: string;
    pages: string;
    details?: boolean;
    headless: boolean;
    verbose?: boolean;
    cnae?: string;
  }) => {
    const pages = parseInt(opts.pages, 10);
    console.log(`Scraping ${pages} page(s) from basecnpj.com.br...`);

    const companies = await scrapeAllPages({
      pages,
      details: !!opts.details,
      headless: opts.headless,
      verbose: !!opts.verbose,
      cnae: opts.cnae,
    });

    console.log(`\n--- Results (${companies.length} companies) ---`);
    for (const c of companies) {
      console.log(`[${c.status}] ${c.companyName} (${c.cnpjFull ?? c.cnpj}) — ${c.location}`);
      console.log(`  ${c.detailUrl}`);
      if (c.razaoSocial) console.log(`  Razão Social: ${c.razaoSocial}`);
      if (c.endereco) console.log(`  Endereço: ${c.endereco}`);
      if (c.cnaePrincipal) console.log(`  CNAE: ${c.cnaePrincipal}`);
    }

    if (opts.output) {
      if (opts.output.endsWith(".json")) {
        await writeCnpjJson(opts.output, companies);
        console.log(`\nJSON written to ${opts.output}`);
      } else {
        await writeCnpjCsv(opts.output, companies);
        console.log(`\nCSV written to ${opts.output}`);
      }
    }

    console.log(`\nTotal: ${companies.length} companies scraped`);
  });

program.parse();

import { config } from "dotenv";
import { Command } from "commander";
import { textSearch, getPlaceDetails } from "./places";
import { classifyPhone, buildWaMeLink } from "./phone";
import { writeCsv } from "./csv";
import { ExtractedContact, PlaceTextSearchResult } from "./types";

config();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const program = new Command();
  program
    .name("gmaps-whatsapp-extractor")
    .description("Extract WhatsApp links from Google Maps search results")
    .argument("<query>", "Google Maps search query")
    .option("-o, --output <file>", "CSV output file path")
    .option("-c, --country <code>", "Default country code for phone parsing (e.g. BR)")
    .option("-l, --limit <n>", "Max results to process", "60")
    .parse();

  const query = program.args[0];
  const opts = program.opts<{ output?: string; country?: string; limit: string }>();
  const limit = parseInt(opts.limit, 10);

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.error("Error: GOOGLE_MAPS_API_KEY not set. Create a .env file or set the environment variable.");
    process.exit(1);
  }

  // Step 1: Text Search — collect results up to limit
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

  // Step 2: Fetch details and extract contacts
  const contacts: ExtractedContact[] = [];
  let withPhone = 0;

  for (const place of places) {
    const details = await getPlaceDetails(place.name, apiKey);

    if (details.internationalPhoneNumber) {
      withPhone++;
      const result = classifyPhone(details.internationalPhoneNumber, opts.country);

      if (result && result.isMobile) {
        const waMeLink = buildWaMeLink(result.e164);
        contacts.push({
          name: details.displayName.text,
          phone: result.e164,
          waMeLink,
          address: details.formattedAddress,
        });
        console.log(`${details.displayName.text}: ${waMeLink}`);
      }
    }

    await sleep(200);
  }

  // Step 3: CSV output
  if (opts.output) {
    await writeCsv(opts.output, contacts);
    console.log(`\nCSV written to ${opts.output}`);
  }

  // Step 4: Summary
  console.log(`\nSummary: Found ${places.length} places, ${withPhone} had phones, ${contacts.length} were mobile`);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});

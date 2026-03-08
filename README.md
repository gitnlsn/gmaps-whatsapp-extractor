# gmaps-whatsapp-extractor

CLI tool that searches Google Maps for businesses and extracts WhatsApp links from their mobile phone numbers.

## How it works

1. Searches Google Maps using the [Places API (New)](https://developers.google.com/maps/documentation/places/web-service/op-overview)
2. Fetches phone numbers for each result
3. Classifies numbers as mobile or landline
4. Generates `wa.me` links for mobile numbers
5. Optionally exports results to CSV

## Prerequisites

- Node.js 18+
- A Google Cloud project with the **Places API (New)** enabled
- An API key with access to the Places API

## Setup

```bash
npm install
```

Create a `.env` file:

```
GOOGLE_MAPS_API_KEY=your_api_key_here
```

## Usage

```bash
npx tsx src/cli.ts <query> [options]
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `-c, --country <code>` | Default country code for phone parsing (e.g. `BR`) | — |
| `-o, --output <file>` | CSV output file path | — |
| `-l, --limit <n>` | Max results to process | `60` |

### Examples

```bash
# Search for clinics in São Paulo, limit to 30 results
npx tsx src/cli.ts "clinicas de psicologia em são paulo" -c BR --limit 30

# Export results to CSV
npx tsx src/cli.ts "restaurants in Tokyo" -c JP --limit 20 -o results.csv
```

### CSV output

The CSV file contains the following columns:

```
name, phone, wa_me_link, address
```

## Project structure

```
src/
├── cli.ts      # CLI entry point and orchestration
├── places.ts   # Google Places API (New) client
├── phone.ts    # Phone number classification (mobile/landline)
├── csv.ts      # CSV formatting and export
└── types.ts    # TypeScript interfaces
```

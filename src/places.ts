import { Budget } from "./budget";

const BASE_URL = "https://places.googleapis.com/v1";

/**
 * Field masks are split by billing tier. Google charges the HIGHEST tier that
 * any single field in the mask touches, so mixing a cheap field with an
 * expensive one costs the expensive price for the whole call.
 *
 *   Essentials  10,000 free/month   $1.70/1k text search
 *   Pro          5,000 free/month  $32.00/1k
 *   Enterprise   1,000 free/month  $35.00/1k   <- phone, website, rating live here
 *
 * Discovery therefore uses the ID-only mask (10x the free quota, 20x cheaper),
 * and only leads that survive the rules filter get an Enterprise Details call.
 *
 * `editorialSummary` is deliberately absent: it is the single field that pushes
 * Place Details from Enterprise ($20/1k) to Enterprise+Atmosphere ($25/1k), and
 * nothing in this pipeline reads it.
 */
export const MASKS = {
  searchIdOnly: "places.id,nextPageToken",
  searchPro: "places.id,places.displayName,places.formattedAddress,places.primaryType,places.businessStatus,nextPageToken",
  detailsEnterprise:
    "id,displayName,formattedAddress,businessStatus,primaryType," +
    "internationalPhoneNumber,websiteUri,rating,userRatingCount",
} as const;

export interface PlaceRef {
  id: string;
}

export interface PlaceDetails {
  id: string;
  displayName?: { text: string };
  formattedAddress?: string;
  businessStatus?: string;
  primaryType?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  label: string,
  retries = 4
): Promise<Response> {
  let lastErr: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(1000 * 2 ** (attempt - 1), 16000));

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      lastErr = new Error(`${label} network error: ${(err as Error).message}`);
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`${label} ${res.status}: ${(await res.text()).slice(0, 200)}`);
      continue;
    }
    return res;
  }

  throw lastErr ?? new Error(`${label} failed`);
}

/**
 * Text Search, ID-only. Max 60 results across 3 pages — that ceiling is the
 * API's, not a tuning knob, which is why the planner fans out into many narrow
 * queries instead of one broad one.
 */
export async function* searchIds(
  query: string,
  apiKey: string,
  budget: Budget
): AsyncGenerator<PlaceRef[]> {
  let pageToken: string | undefined;

  for (let page = 0; page < 3; page++) {
    await budget.check("textsearch.essentials");

    const body: Record<string, unknown> = {
      textQuery: query,
      pageSize: 20,
      languageCode: "pt-BR",
      regionCode: "BR",
    };
    if (pageToken) body.pageToken = pageToken;

    const res = await fetchWithRetry(
      `${BASE_URL}/places:searchText`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": MASKS.searchIdOnly,
        },
        body: JSON.stringify(body),
      },
      "Text Search"
    );

    if (!res.ok) {
      // A 4xx is not a billable request, so it must not count against budget.
      throw new Error(`Text Search ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    await budget.record("textsearch.essentials");

    const data = (await res.json()) as {
      places?: PlaceRef[];
      nextPageToken?: string;
    };

    if (data.places?.length) yield data.places;
    if (!data.nextPageToken) return;
    pageToken = data.nextPageToken;

    // The New API documents no delay for nextPageToken, but the legacy API
    // required one. Cheap insurance against an INVALID_ARGUMENT.
    await sleep(1200);
  }
}

/** Place Details at Enterprise tier — only 1,000 free per month. Use sparingly. */
export async function getDetails(
  placeId: string,
  apiKey: string,
  budget: Budget
): Promise<PlaceDetails> {
  await budget.check("details.enterprise");

  const res = await fetchWithRetry(
    `${BASE_URL}/places/${placeId}`,
    {
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": MASKS.detailsEnterprise,
        "Accept-Language": "pt-BR",
      },
    },
    "Place Details"
  );

  if (!res.ok) {
    // A 4xx is not a billable request, so it must not count against budget.
    throw new Error(`Place Details ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  await budget.record("details.enterprise");

  return res.json() as Promise<PlaceDetails>;
}

/**
 * Refreshes a stored place_id. Google recommends re-validating IDs older than
 * 12 months and makes the ID-only Details call free, so this costs nothing.
 */
export async function refreshPlaceId(
  placeId: string,
  apiKey: string
): Promise<string | null> {
  const res = await fetchWithRetry(
    `${BASE_URL}/places/${placeId}`,
    { headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "id" } },
    "Place ID refresh"
  );
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) return placeId;
  const data = (await res.json()) as { id?: string };
  return data.id ?? placeId;
}

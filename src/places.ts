import { PlaceTextSearchResult, TextSearchResponse, PlaceDetails } from "./types";

const BASE_URL = "https://places.googleapis.com/v1";

export async function* textSearch(
  query: string,
  apiKey: string
): AsyncGenerator<PlaceTextSearchResult[]> {
  let pageToken: string | undefined;

  while (true) {
    const body: Record<string, unknown> = { textQuery: query, pageSize: 20 };
    if (pageToken) {
      body.pageToken = pageToken;
    }

    const res = await fetch(`${BASE_URL}/places:searchText`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.name,places.displayName,places.formattedAddress,places.websiteUri,places.rating,places.userRatingCount,places.primaryType,nextPageToken",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Text Search API error (${res.status}): ${text}`);
    }

    const data: TextSearchResponse = await res.json();

    if (data.places && data.places.length > 0) {
      yield data.places;
    }

    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
}

export async function getPlaceDetails(
  resourceName: string,
  apiKey: string
): Promise<PlaceDetails> {
  const res = await fetch(`${BASE_URL}/${resourceName}`, {
    headers: {
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "displayName,formattedAddress,internationalPhoneNumber,websiteUri,rating,userRatingCount,primaryType,editorialSummary,regularOpeningHours,googleMapsUri",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Place Details API error (${res.status}): ${text}`);
  }

  return res.json();
}

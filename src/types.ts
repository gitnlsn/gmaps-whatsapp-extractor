export interface PlaceTextSearchResult {
  name: string;           // resource name e.g. "places/ChIJ..."
  displayName: { text: string };
  formattedAddress: string;
}

export interface TextSearchResponse {
  places?: PlaceTextSearchResult[];
  nextPageToken?: string;
}

export interface PlaceDetails {
  displayName: { text: string };
  formattedAddress: string;
  internationalPhoneNumber?: string;
}

export interface ExtractedContact {
  name: string;
  phone: string;
  waMeLink: string;
  address: string;
}

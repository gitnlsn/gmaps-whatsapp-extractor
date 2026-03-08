export interface PlaceTextSearchResult {
  name: string;           // resource name e.g. "places/ChIJ..."
  displayName: { text: string };
  formattedAddress: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  primaryType?: string;
}

export interface TextSearchResponse {
  places?: PlaceTextSearchResult[];
  nextPageToken?: string;
}

export interface PlaceDetails {
  displayName: { text: string };
  formattedAddress: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  primaryType?: string;
  editorialSummary?: { text: string };
  regularOpeningHours?: { openNow?: boolean };
  googleMapsUri?: string;
}

export interface LeadScore {
  score: number;
  reason: string;
}

export interface CnpjCompany {
  status: string;
  companyName: string;
  cnpj: string;
  location: string;
  detailUrl: string;
  razaoSocial?: string;
  capitalSocial?: string;
  cnaePrincipal?: string;
  dataAbertura?: string;
  nomeFantasia?: string;
  naturezaJuridica?: string;
  endereco?: string;
  cnaesSecundarios?: string;
  cnpjFull?: string;
}

export interface ExtractedContact {
  name: string;
  phone: string;
  waMeLink: string;
  address: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  primaryType?: string;
  googleMapsUri?: string;
  leadScore?: number;
  leadScoreReason?: string;
}

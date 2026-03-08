import { parsePhoneNumber, CountryCode } from "libphonenumber-js";

export function classifyPhone(
  rawNumber: string,
  defaultCountry?: string
): { e164: string; isMobile: boolean } | null {
  try {
    const parsed = parsePhoneNumber(rawNumber, defaultCountry as CountryCode | undefined);
    if (!parsed || !parsed.isValid()) return null;

    const type = parsed.getType();
    const isMobile = type === "MOBILE" || type === "FIXED_LINE_OR_MOBILE";

    return { e164: parsed.format("E.164"), isMobile };
  } catch {
    return null;
  }
}

export function buildWaMeLink(e164: string): string {
  const digits = e164.replace("+", "");
  return `https://wa.me/${digits}`;
}

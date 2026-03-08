import { ExtractedContact, LeadScore } from "./types";

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

function buildPrompt(contact: ExtractedContact): string {
  return `You are a lead qualification assistant. Score this business on a scale of 1-10 for likelihood of needing web/developer services (website creation, app development, digital presence).

Business data:
- Name: ${contact.name}
- Type: ${contact.primaryType ?? "unknown"}
- Has website: ${contact.websiteUri ? "yes" : "no"}
- Rating: ${contact.rating ?? "N/A"}
- Review count: ${contact.userRatingCount ?? "N/A"}
- Address: ${contact.address}

Key signals:
- No website + good ratings = HIGH score (they have customers but no digital presence)
- Has website already = LOWER score (less likely to need one)
- More reviews = more established business = better lead

Respond ONLY with valid JSON, no markdown:
{"score": <1-10>, "reason": "<one sentence justification>"}`;
}

export async function scoreLead(
  contact: ExtractedContact,
  apiKey: string
): Promise<LeadScore> {
  const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt(contact) }] }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${text}`);
  }

  const data = await res.json();
  const text: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  try {
    const parsed = JSON.parse(text.trim());
    return {
      score: Math.max(1, Math.min(10, Math.round(parsed.score))),
      reason: String(parsed.reason),
    };
  } catch {
    return { score: 5, reason: "Could not parse Gemini response" };
  }
}

export async function scoreLeads(
  contacts: ExtractedContact[],
  apiKey: string
): Promise<ExtractedContact[]> {
  const results: ExtractedContact[] = [];

  for (const contact of contacts) {
    const { score, reason } = await scoreLead(contact, apiKey);
    results.push({ ...contact, leadScore: score, leadScoreReason: reason });
    // Small delay to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return results.sort((a, b) => (b.leadScore ?? 0) - (a.leadScore ?? 0));
}

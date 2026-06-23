// Netlify Function: contact-intel
//
// POST /.netlify/functions/contact-intel
// Body: { text: string, existingContact?: object }
//
// Calls Claude to:
//   1. Extract structured contact fields from free-form text
//   2. Enrich with known background info (senior military / DoD officials)
//   3. Return clarifying questions where data is uncertain
//
// Returns:
//   { extracted, enrichment, questions, engagementNote }

const ANTHROPIC_API     = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL             = 'claude-sonnet-4-6';

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { text, existingContact } = body;
  if (!text || !text.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'text is required' }) };
  }

  const systemPrompt = `You are a DoD CRM assistant helping a defense contractor or program manager log contacts and engagements.

Given free-form text describing a meeting, encounter, or person, you will:
1. Extract structured contact data
2. Enrich with any known background (use your knowledge of DoD/military officials, senior officers, defense personnel — you often know their background, current/recent roles, service branch, etc.)
3. Generate targeted clarifying questions where you are uncertain

Return a JSON object with this exact shape:
{
  "extracted": {
    "firstName": "",
    "lastName": "",
    "rank": "",
    "callsign": "",
    "title": "",
    "org": "",
    "department": "",
    "email": "",
    "phone": "",
    "branch": ""
  },
  "enrichment": {
    "found": true/false,
    "summary": "2-3 sentence background on this person if known, else empty string",
    "currentRole": "",
    "previousRoles": [],
    "linkedinHint": "likely LinkedIn URL pattern if known, else empty string",
    "bioUrl": "URL of the person's official bio page if you know it (e.g. https://www.spaceforce.mil/Biographies/... or https://www.army.mil/leaders/...). Leave empty string if unknown.",
    "confidence": "high/medium/low",
    "caveat": "any caveats about accuracy — e.g. 'multiple officers with this name exist' or 'could not find specific info'"
  },
  "engagementDate": "ISO date (YYYY-MM-DD) of the engagement/meeting if mentioned in the text, else empty string",
  "engagementNote": "cleaned-up version of the engagement/meeting note portion of the text, suitable for the contact's notes field",
  "questions": [
    {
      "field": "the contact field this question clarifies",
      "question": "plain English question to ask the user",
      "suggestedAnswer": "your best guess if you have one, else empty string"
    }
  ]
}

Rules:
- Only put fields in "extracted" that you are reasonably confident about from the text
- Leave fields empty string if not mentioned or not clear
- For "questions", only ask about things that are genuinely uncertain and matter for CRM records (rank, title, org, correct spelling of name). Don't ask about every field.
- Maximum 4 questions
- If the person is a well-known DoD/military figure, use that knowledge in enrichment
- The engagementNote should preserve key facts (date, topic, outcomes) in a clean, professional format
- Return ONLY the JSON object, no markdown, no explanation`;

  const userMessage = existingContact
    ? `Existing contact on file: ${JSON.stringify(existingContact, null, 2)}\n\nNew engagement text:\n${text}`
    : text;

  let claudeResp;
  try {
    const res = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || JSON.stringify(data).slice(0, 200));
    claudeResp = data.content?.[0]?.text || '';
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: 'Claude API error: ' + e.message }) };
  }

  // Strip markdown code fences if Claude added them
  const cleaned = claudeResp.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch {
    return { statusCode: 502, body: JSON.stringify({ error: 'Claude returned non-JSON', raw: claudeResp.slice(0, 500) }) };
  }

  // ── Bio page scraping ──────────────────────────────────────────
  // If Claude identified an official bio URL, fetch it and extract
  // the headshot (og:image or first prominent img) plus any bio text
  // to improve enrichment accuracy.
  const bioUrl = parsed.enrichment && parsed.enrichment.bioUrl;
  if (bioUrl && /^https?:\/\//i.test(bioUrl)) {
    try {
      const bioRes = await fetch(bioUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Waypoint-CRM/1.0)' },
        redirect: 'follow',
      });
      if (bioRes.ok) {
        const html = await bioRes.text();

        // Extract og:image (most .mil and .gov sites use Open Graph tags)
        const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                     || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
        if (ogMatch && ogMatch[1]) {
          parsed.photoUrl = ogMatch[1];
        } else {
          // Fallback: look for a biography headshot img (spaceforce/army/af pattern)
          const imgMatch = html.match(/<img[^>]+class=["'][^"']*bio(?:graphy)?[^"']*["'][^>]+src=["']([^"']+)["']/i)
                        || html.match(/<img[^>]+src=["']([^"'?#]+\.(?:jpg|jpeg|png|webp))["'][^>]*>/i);
          if (imgMatch && imgMatch[1]) {
            // Resolve relative URLs
            const base = new URL(bioUrl);
            parsed.photoUrl = imgMatch[1].startsWith('http') ? imgMatch[1]
              : imgMatch[1].startsWith('/') ? (base.origin + imgMatch[1])
              : (base.origin + '/' + imgMatch[1]);
          }
        }

        // Extract visible bio text to pass back for reference
        const textContent = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .trim()
          .slice(0, 2000);
        parsed.enrichment.bioScraped = textContent;
        parsed.enrichment.bioUrlFetched = bioUrl;
      }
    } catch (scrapeErr) {
      // Non-fatal — log but continue
      parsed.enrichment.bioScrapeError = scrapeErr.message || String(scrapeErr);
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(parsed),
  };
};

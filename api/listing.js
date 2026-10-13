// Vercel serverless function: proxies the listing interview to Parley.
// Env vars (set in Vercel, never in the repo): PARLEY_BASE_URL, PARLEY_API_KEY, PARLEY_MODEL

const SYSTEM_PROMPT = `You are helping a homeowner build an MLS listing for their home. You will receive their property record as JSON. Interview them to fill gaps.

Rules:
- Ask exactly one question per turn. Plain, friendly language.
- Only ask about fields that are missing or thin in the record: interior and exterior updates and finishes, standout features, condition, taxes and fees, listing history.
- Ask at most 8 questions total. Stop sooner if you have enough.
- Never ask for or use information about who the buyer might be.
- Fair housing: do not describe a home as ideal for any type of person or family, and never mention religion, race, national origin, sex, disability, familial status, or other protected classes. Describe the property only.
- Do not invent features. If the seller did not say it, do not write it.
- Do not give a listing price; pricing is handled elsewhere in the app.
- When the user says to begin, ask your first question.
When finished, reply with exactly one block and nothing else:
<final>{"fields": {...MLS fields as JSON...}, "description": "public remarks, max ~1000 characters"}</final>`;

const MAX_MESSAGES = 30;   // conversation length cap
const MAX_USER_TURNS = 14; // hard stop on runaway chats
const MAX_TOKENS = 800;    // credit guard

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const { property, messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages required" });
    }

    const trimmed = messages.slice(-MAX_MESSAGES).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content).slice(0, 2000),
    }));

    // Anthropic format requires the first message to be from the user.
    while (trimmed.length && trimmed[0].role !== "user") trimmed.shift();
    if (!trimmed.length) return res.status(400).json({ error: "need a user message" });

    if (trimmed.filter((m) => m.role === "user").length > MAX_USER_TURNS) {
      return res.status(400).json({ error: "conversation too long" });
    }

    const upstream = await fetch(`${process.env.PARLEY_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.PARLEY_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.PARLEY_MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT + "\n\nProperty record:\n" + JSON.stringify(property || {}),
        messages: trimmed,
      }),
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      console.error("Parley error", upstream.status, detail.slice(0, 300));
      return res.status(502).json({ error: "upstream " + upstream.status });
    }

    const data = await upstream.json();
    const reply = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    return res.status(200).json({ reply });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "server error" });
  }
}

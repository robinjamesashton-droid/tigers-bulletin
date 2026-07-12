import type { Context, Config } from "@netlify/functions";

const PROMPT = "Search the web for the latest news about Hull City AFC (the English football club, nicknamed The Tigers, playing in the EFL Championship). Use at most 4 search queries total. Prioritize reputable football/sports sources such as BBC Sport, Sky Sports, Hull Live / Hull Daily Mail, or the club's official site, and include the 1904 Podcast (the Hull City fan podcast) if relevant recent content exists. When a story comes from the 1904 Podcast, set \"source\" to \"1904 Podcast\". Find exactly 5 distinct, recent stories — do not search for more than that. Respond with ONLY a raw JSON array (no markdown fences, no commentary) where each item has exactly these keys: \"headline\" (string, in your own words), \"source\" (string, publication name), \"date\" (string, human-readable, e.g. '12 Jul 2026'), \"iso_date\" (string, YYYY-MM-DD, best estimate if unstated), \"summary\" (string, 1-2 sentences in your own words, never a direct quote), \"url\" (string, direct article URL). Order the array with the newest story first. Return nothing except that JSON array.";

export default async (req: Request, context: Context) => {
  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");

  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "Server is missing ANTHROPIC_API_KEY. Add it in Site settings > Environment variables." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
        messages: [{ role: "user", content: PROMPT }],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      return new Response(
        JSON.stringify({ error: `Anthropic API request failed (${response.status}): ${bodyText.slice(0, 300)}` }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    const data = await response.json();

    const textBlocks = (data.content || [])
      .filter((item: any) => item.type === "text")
      .map((item: any) => item.text)
      .join("\n");

    if (!textBlocks.trim()) {
      return new Response(
        JSON.stringify({ error: "The model returned no text, it may have run out of room mid-search." }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    let cleaned = textBlocks.trim();
    cleaned = cleaned.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();

    const firstBracket = cleaned.indexOf("[");
    const lastBracket = cleaned.lastIndexOf("]");
    if (firstBracket !== -1 && lastBracket !== -1) {
      cleaned = cleaned.slice(firstBracket, lastBracket + 1);
    }

    const stories = JSON.parse(cleaned);

    if (Array.isArray(stories)) {
      stories.sort((a: any, b: any) => {
        const dateA = a && a.iso_date ? Date.parse(a.iso_date) : NaN;
        const dateB = b && b.iso_date ? Date.parse(b.iso_date) : NaN;
        if (isNaN(dateA) && isNaN(dateB)) return 0;
        if (isNaN(dateA)) return 1;
        if (isNaN(dateB)) return -1;
        return dateB - dateA;
      });
    }

    return new Response(JSON.stringify({ stories }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err?.message || "Unknown server error" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

export const config: Config = {
  path: "/api/get-news",
};
